import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import path from 'path';
import { urlDashBase, conf } from '../lib/store.js';
import { UserToken } from './login.js';
import sharp from 'sharp';

const SIGNED_URIS = 200;
const UPLOAD_THREADS = 15;
const PROCESSING_THREADS = 8;
const PROCESSING_THREADS_OMNI = 1;

const account = conf.get('account') as UserToken;

const api = <T>(path:string, data?:Object) : Promise<T|undefined> => fetch(urlDashBase+path,{
	method: data ? 'POST' : 'GET',
	headers: Object.fromEntries([
		['Cookie', `.AspNetCore.Identity.Application=${account.base64};`],
		...(data ? [['Content-Type', 'application/json']] : [])
	]),
	body: data ? JSON.stringify(data) : undefined
}).then(r => r?.json() as T, () => undefined).then(r => {
	const error = r && typeof r == 'object' && 'error' in r ? r['error'] as string : undefined;
	if(error) {
		console.error('Error on URL: ' + path, data);
		throw new Error(error);
	}
	return r;
});

const error = (str:string) : void => console.log('Error: ' + str);
const sanitize = (f:string, outDir:string) : string => f.replace(/\\+/g,'/').replace(outDir+'/','');

interface R2StoreResult {
	time: string;
	key: string;
	account: string;
	keys: string[];
};

type FormatType = ('jpg'|'webp'|'png');
type ImageType = ('2d'|'360'|'omni');

export async function upload(ignore:any, opts:{
	destination: string;
	format: FormatType;
	type: ImageType;
	dpi: string;
}, o:{args: string[]}) {
	if(!account?.email) return error(`Not logged in. Run 'micrio login' first`);

	let url;
	try { url = new URL(opts.destination) } catch(e) {
		return error('Invalid target URL. This has to be the full URL of the target folder of the Micrio dashboard (https://dash.micr.io/...)');
	}

	const folder = url.pathname;

	const start = Date.now();

	const allFiles = fs.readdirSync('.').filter(f => !fs.lstatSync(f).isDirectory());
	let files = o.args.map(f => {
		if(!/\*/.test(f)) return [f]
		const rx = new RegExp(f.replace(/\./g,'\\.').replace(/\*/g,'.+'), 'i');
		return allFiles.filter(f => rx.test(f));
	}).reduce((a, b) => [...a,...b], []).sort((a, b) => a > b ? 1 : a < b ? -1 : 0);
	files = files.filter((f,i) => files.indexOf(f) == i);

	if(!files.length) return error('No images to process');

	const origImageNum = files.length;

	const tmpDir = path.join(os.tmpdir(), '_micrio');
	if(!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
	const outDir = path.join(tmpDir, Math.floor(Math.random()*10000000)+'');
	if(!fs.existsSync(outDir)) fs.mkdirSync(outDir);

	let omniId:string|undefined;

	for(let i=0;i<files.length;i++) { const f = files[i]; if(f.endsWith('.pdf')) try {
		const info = GetPdfInfo(f);
		files.splice(i--, 1);
		for(let p=0;p<info.pages;p++) files.push(f+'.'+(p+1).toString().padStart(4, '0'));
		i+=info.pages;
	} catch(e) {
		/** @ts-ignore */
		return error(e?.['message']??e??'An unknown error occurred');
	}}

	const uploader = new Uploader(folder, opts.format, outDir);

	const hQueue:{[key:string]:Promise<any>} = {};
	const threads = opts.type == 'omni' ? PROCESSING_THREADS_OMNI : PROCESSING_THREADS;
	for(let i=0;i<files.length;i++) try {
		const queue = Object.values(hQueue);
		if(queue.length >= threads) await Promise.any(queue);
		const f = files[i];
		log(`Processing ${i+1} / ${files.length}...`, 0);
		hQueue[f] = handle(uploader, f, outDir, folder, opts.format, opts.type, i, files.length, omniId, id => omniId = id, {
			pdfDpi: opts.dpi
		}).then(() => delete hQueue[f]);
	} catch(e) {
		/** @ts-ignore */
		return error(e?.['message']??e??'An unknown error occurred');
	}

	await Promise.all(Object.values(hQueue));
	await uploader.complete();

	if(omniId) {
		const baseBinDir = path.join(outDir, omniId+'_basebin');
		console.log('Creating optimized viewing package...');
		const tiles:{
			path: string;
			buffer: Buffer;
		}[] = [];
		walkSync(baseBinDir, t => tiles.push({
			path: t.replace(/\\/g,'/').replace(/^.*_basebin\//,''),
			buffer: fs.readFileSync(t)
		}));
		const binPath = `${omniId}/base.bin`;
		const postUri = await api<R2StoreResult>(`/api/${url.pathname.split('/')[1]}/store`, {
			files: [binPath]
		}).then(r => {
			if(!r) throw new Error('Upload permission denied.');
			return r.keys.map((sig,i) => `https://micrio.${r.account}.r2.cloudflarestorage.com/${binPath}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=${r.key}%2F${r.time.slice(0,8)}%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=${r.time}&X-Amz-Expires=300&X-Amz-Signature=${sig}&X-Amz-SignedHeaders=host&x-id=PutObject`)
		});
		await fetch(postUri[0], {
			method: 'PUT',
			body: generateMDP(tiles),
			headers: { 'Content-Type': 'application/octet-stream' }
		});
	}

	fs.rmSync(outDir, {recursive: true, force: true});

	log(`Succesfully added ${origImageNum} file${origImageNum==1?'':'s'} in ${Math.round(Date.now()-start)/1000}s.`, 0);
	console.log();
}

const walkSync = (dir:string, callback:(s:string)=>void) : void => fs.lstatSync(dir).isDirectory()
	? fs.readdirSync(dir).forEach(f => walkSync(path.join(dir, f), callback))
	: callback(dir);

const pdfPageRx = /^(.*\.pdf)\.(\d+)$/;

interface TileResult {
	width: number;
	height: number;
}

const tile = (destDir: string, file:string, format:FormatType) : Promise<TileResult> => new Promise((ok, err) => {
	sharp(fs.readFileSync(file), {
		limitInputPixels: 1E5 * 1E5,
		unlimited: true
	}).toFormat(format, {
		quality: format == 'webp' ? 75 : 85
	}).tile({
		size: 1024,
		overlap: 0,
		depth: 'onepixel',
		container: 'fs',
		layout: 'dz'
	}).toFile(destDir, (error:any, info?:TileResult) => {
		if(error||!info) err(error??'Could not tile image');
		else ok(info);
	})
});

async function handle(
	uploader:Uploader,
	f:string,
	outDir:string,
	folder:string,
	format:FormatType,
	type:ImageType,
	idx:number,
	total:number,
	omniId:string|undefined,
	setOmniId:(i:string)=>void,
	opts: {
		pdfDpi?: number|string
	} = {}
) {
	const isOmni = type=='omni';
	const isPdfPage = pdfPageRx.test(f);
	if(isPdfPage) {
		const basePdf = f.match(pdfPageRx)![1], pdfPage = Number(f.match(pdfPageRx)![2])-1;
		f+='.tif';
		execSync(`vips pdfload ${basePdf} --page=${pdfPage} --dpi=${opts.pdfDpi??'150'} ${f}`);
	}

	if(!fs.existsSync(f)) throw new Error(`File '${f}' not found`);

	const fName = isPdfPage ? f.replace(/\.tif$/,'') : f;

	const res = omniId ? {id: omniId} : await api<{id:string}>(`/api/cli${folder}/create`,{
		name: fName, type, format
	});
	if(!res) throw new Error('Could not create image in Micrio! Do you have the correct permissions?');

	outDir = sanitize(outDir,outDir)
	const baseDir = path.join(outDir, res.id, isOmni ? idx.toString() : '');

	const {width, height} = await tile(baseDir, f, format);
	if(!height || !width) throw new Error('Could not read image dimensions');

	if(isPdfPage) fs.rmSync(f);

	if(isOmni && !omniId) setOmniId(res.id);

	fs.renameSync(baseDir+'_files', baseDir);

	// Update status
	if(!omniId) await api(`/api/cli${folder}/@${res.id}/status`, {
		width, height, status: 6, format, length: total
	});

	const tiles:string[] = [];
	walkSync(baseDir, t => tiles.push(t));
	uploader.add(tiles);

	// Move tile for base.bin generation
	if(isOmni) uploader.add([async () => {
		const baseBinDir = path.join(outDir, res.id+'_basebin');
		if(!omniId && !fs.existsSync(baseBinDir)) fs.mkdirSync(baseBinDir);
		let d = Math.max(width, height), l = 0;
		while(d > 1024) { d /= 2; l++; }
		let dzLevels = 0, max = Math.max(width, height);
		do dzLevels++; while ((max /= 2) > 1);
		const level = dzLevels - l;
		const baseBinImgDir = path.join(baseBinDir, idx+'');
		fs.mkdirSync(baseBinImgDir);
		fs.renameSync(path.join(baseDir, level.toString()), path.join(baseBinImgDir, level.toString()));
	}]);

	// Finalize
	if(!omniId) uploader.add([() => api(`/api/cli${folder}/@${res.id}/status`, { status: 4 })]);

	fs.rmSync(baseDir+'.dzi');
}

function log(str:string, pos?:number, newLine:boolean=false) {
	if(!newLine) newLine = pos == undefined;
	if(!newLine) {
		process.stdout.cursorTo(pos ?? 0);
		process.stdout.clearLine(1);
	}
	process.stdout.write((pos?' | ':'') + str + (newLine ? '\n' : '\r'));
}

function generateMDP(images:{
	path: string;
	buffer: Buffer;
}[]) {
	const enc = new TextEncoder();
	const arr:Uint8Array[] = [];
	images.forEach(i => {
		if(!i.buffer || !i.path) return;
		const name = enc.encode(i.path); // byte[20]
		const size = i.buffer.byteLength.toString(8); // byte[12]
		arr.push(name, new Uint8Array(20 - name.byteLength));
		arr.push(enc.encode('0'.repeat(12 - size.length)+size));
		arr.push(i.buffer);
	});

	return new Blob(arr, {type: 'application/octet-stream'});
}

function GetPdfInfo(file:string) : {
	width: number;
	height: number;
	pages: number;
} {
	const r = new TextDecoder().decode(execSync(`vipsheader -a ${file}`));
	const width = Number(r.match(/width: (\d+)/m)?.[1]),
		height = Number(r.match(/height: (\d+)/m)?.[1]),
		pages = Number(r.match(/(pdf-n_pages|n-pages): (\d+)/m)?.[2]);

	if(!width || !height || !pages) throw new Error('Invalid PDF file');

	return { width, height, pages };
}

type JobType = string|(() => Promise<any>);

class Uploader {
	private jobs:JobType[] = [];
	private uploadUris:string[] = [];
	private started:boolean = false;
	private oncomplete:Function|undefined;

	running:Map<JobType, Promise<any>> = new Map();

	constructor(
		private folder:string,
		private format:FormatType,
		private outDir:string
	) {
		this.outDir = sanitize(outDir, outDir);
	}

	async getUploadUris() {
		const files = this.jobs.filter(t => !(t instanceof Function)).slice(0, SIGNED_URIS) as string[];
		if(files.length) this.uploadUris.push(...await api<R2StoreResult>(`/api/${this.folder.split('/')[1]}/store`, {files : files.map(f => sanitize(f, this.outDir))}).then(r => {
			if(!r) throw new Error('Upload permission denied.');
			return r.keys.map((sig,i) => `https://micrio.${r.account}.r2.cloudflarestorage.com/${sanitize(files[i], this.outDir)}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=${r.key}%2F${r.time.slice(0,8)}%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=${r.time}&X-Amz-Expires=300&X-Amz-Signature=${sig}&X-Amz-SignedHeaders=host&x-id=PutObject`)
		}));
	}

	add(jobs:JobType[]) {
		this.jobs.push(...jobs);
		if(!this.started) this.start();
	}

	async start() {
		if(this.started) return;
		this.started = true;
		while(this.jobs.length) {
			const queue = Array.from(this.running.values());
			if(queue.length >= UPLOAD_THREADS) await Promise.any(queue);
			if(!this.uploadUris.length && !(this.jobs[0] instanceof Function)) await this.getUploadUris();

			const job = this.jobs.shift();
			if(!job) throw new Error('Could not get tile to upload.');

			this.running.set(job, (job instanceof Function ? job() : fetch(this.uploadUris.shift()!, {
				method: 'PUT',
				body: new Blob([fs.readFileSync(job)], {type: `image/${this.format}`}),
				headers: { 'Content-Type': `image/${this.format}` }
			})).then(() => {
				if(this.oncomplete) log(`Remaining uploads: ${this.jobs.length}...`, 0);
				this.running.delete(job)
			}));
		}
		await Promise.all(Array.from(this.running.values()));
		this.started = false;
		this.oncomplete?.();
	}

	complete() : Promise<void> { return new Promise(ok => {
		if(!this.started) return ok();
		this.oncomplete = ok;
	}) }
}
