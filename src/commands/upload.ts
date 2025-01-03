import type { FormatType, ImageInfo, ImageType, R2StoreResult, TileResult, UserToken } from '../types';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { urlDashBase, conf } from '../lib/store.js';
import sharp from 'sharp';
import https from 'https';
import pdf2img from 'pdf-img-convert';

const SIGNED_URIS = 480;
const UPLOAD_THREADS = 100;
const PROCESSING_THREADS = 8;
const OMNI_PROCESSING_THREADS = 2;
const NUM_UPLOAD_TRIES: number = 3;

const account = conf.get('account') as UserToken;

const api = <T>(agent: https.Agent, path:string, data:Object) : Promise<T|undefined> => new Promise((ok, err) => {
	const url = new URL(urlDashBase+path);
	const blob = JSON.stringify(data);
	const req = https.request({
		host: url.host,
		path: url.pathname+url.search,
		method: 'POST',
		agent: agent,
		headers: {
			'Cookie': `.AspNetCore.Identity.Application=${account.base64};`,
			'Content-Type': 'application/json',
			'Content-Length': blob.length
		}
	}, res => {
		const body:Uint8Array[] = [];
		res.on('data', chunk => {
			body.push(chunk);
		})
		.on('end', () => {
			const b = JSON.parse(Buffer.concat(body).toString());
			if(res.statusCode != 200) err(new Error(`${path}: ${res.statusCode} ${res.statusMessage}: ${b?.error ?? 'Unknown error'}`));
			else ok(b);
			req.destroy();
		});
	});
	req.on('error', (e) => {
		err(e);
		req.destroy();
	});
	req.write(blob);
	req.end();
})

const error = (str:string) : void => console.log('Error: ' + str);
const sanitize = (f:string, outDir:string) : string => f.replace(/\\+/g,'/').replace(outDir+'/','');

export async function upload(ignore:any, opts:{
	destination: string;
	format: FormatType;
	type: ImageType;
	pdfScale: string;
}, o:{args: string[]}) {
	if(!account?.email) return error(`Not logged in. Run 'micrio login' first`);

	let url;
	try { url = new URL(opts.destination) } catch(e) {
		return error('Invalid target URL. This has to be the full URL of the target folder of the Micrio dashboard (https://dash.micr.io/...)');
	}

	const folder = url.pathname;
	const httpAgent = new https.Agent({
		rejectUnauthorized: true,
		keepAlive: true,
		timeout: 3000
	});

	const start = Date.now();

	const allFiles = fs.readdirSync('.').filter(f => !fs.lstatSync(f).isDirectory());
	let files = o.args.map(f => {
		if(!/\*/.test(f)) return [f]
		const rx = new RegExp(f.replace(/\./g,'\\.').replace(/\*/g,'.+'), 'i');
		return allFiles.filter(f => rx.test(f));
	}).reduce((a, b) => [...a,...b], []).sort((a, b) => a > b ? 1 : a < b ? -1 : 0);
	files = files.filter((f,i) => files.indexOf(f) == i);

	if(!files.length) return error('No images to process');

	let origImageNum = files.length;

	const tmpDir = path.join(os.tmpdir(), '_micrio');
	if(!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
	const outDir = path.join(tmpDir, Math.floor(Math.random()*10000000)+'');
	if(!fs.existsSync(outDir)) fs.mkdirSync(outDir);

	// TS is weird here -- if this can be undefined, compilation messes up
	let omni:{
		id?: string;
		width?: number;
		height?: number;
	} = {};

	let hasPdf:boolean = false;

	// PDF parser
	for(let i=0;i<files.length;i++) { const f = files[i]; if(f.endsWith('.pdf')) {
		log(`Parsing PDF file ${f}...`);
		hasPdf = true;
		await pdf2img.convert(f, {scale: parseInt(opts.pdfScale||'4')}).then(pages => pages.forEach((p,j) => {
			const fName = `${f}.${(j+1).toString().padStart(4, '0')}.png`;
			fs.writeFileSync(fName, p);
			files.push(fName);
		}), e => error(`PDF reading error: ${e.toString()}`));
		files.splice(i--, 1);
	}}

	const uploader = new Uploader(httpAgent, folder, opts.format, outDir);

	const hQueue:{[key:string]:Promise<any>} = {};
	// Omni starts with single image to create main ID
	// PDF one by one to preserve correct order
	let threads = hasPdf || opts.type == 'omni' ? 1 : PROCESSING_THREADS;
	for(let i=0;i<files.length;i++) try {
		const queue = Object.values(hQueue);
		if(queue.length >= threads) await Promise.any(queue);
		const f = files[i];
		log(`Processing ${i+1} / ${files.length}...`, 0);
		hQueue[f] = handle(uploader, f, outDir, folder, opts.format, opts.type, i, files.length, omni?.id).then((r) => {
			delete hQueue[f];
			if(opts.type == 'omni' && !omni.id) {
				omni = r;
				threads = OMNI_PROCESSING_THREADS;
			}
		}, (e) => {
			throw e;
			error(`Could not tile ${f}: ${e?.message?.trim() ?? 'Unknown error'}`);
			origImageNum--;
			if(opts.type == 'omni') throw e;
			else delete hQueue[f];
		});
	} catch(e) {
		/** @ts-ignore */
		return error(e?.['message']??e??'An unknown error occurred');
	}

	await Promise.all(Object.values(hQueue));
	if(origImageNum) console.log();
	await uploader.complete();
	console.log();

	if(omni.id && omni.width && omni.height) {
		const baseBinDir = path.join(outDir, omni.id+'_basebin');
		console.log('Creating optimized viewing package...');

		fs.mkdirSync(baseBinDir);
		let d = Math.max(omni.width, omni.height), l = 0;
		while(d > 1024) { d /= 2; l++; }
		let dzLevels = 0, max = Math.max(omni.width, omni.height);
		do dzLevels++; while ((max /= 2) > 1);
		const level = dzLevels - l;

		for(let i=0;i<files.length;i++) {
			const baseDir = path.join(outDir, omni.id, i.toString());
			const baseBinImgDir = path.join(baseBinDir, i.toString());
			fs.mkdirSync(baseBinImgDir);
			fs.renameSync(path.join(baseDir, level.toString()), path.join(baseBinImgDir, level.toString()));
		}

		const tiles:{
			path: string;
			buffer: Buffer;
		}[] = [];
		walkSync(baseBinDir, t => tiles.push({
			path: t.replace(/\\/g,'/').replace(/^.*_basebin\//,''),
			buffer: fs.readFileSync(t)
		}));
		const binPath = `${omni.id}/base.bin`;
		const postUri = await api<R2StoreResult>(httpAgent, `/api/${url.pathname.split('/')[1]}/store`, {
			files: [binPath]
		}).then(r => {
			if(!r) throw new Error('Upload permission denied.');
			return r.keys.map((sig,i) => `https://${r.r2Base}.r2.cloudflarestorage.com/${binPath}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=${r.key}%2F${r.time.slice(0,8)}%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=${r.time}&X-Amz-Expires=300&X-Amz-Signature=${sig}&X-Amz-SignedHeaders=host&x-id=PutObject`)
		});
		await fetch(postUri[0], {
			method: 'PUT',
			body: generateMDP(tiles),
			headers: { 'Content-Type': 'application/octet-stream' }
		});
		await api(uploader.agent, `/api/cli${folder}/@${omni.id}/status`, { status: 4 });
	}

	console.log('Finalizing...');
	fs.rmSync(outDir, {recursive: true, force: true});

	log(`${origImageNum ? 'Succesfully a' : 'A'}dded ${opts.type == 'omni' ? `a 360 object image (${origImageNum} frames)` : `${origImageNum} file${origImageNum==1?'':'s'}`} in ${Math.round(Date.now()-start)/1000}s.`, 0);
	console.log();

	process.exit(1);
}

const walkSync = (dir:string, callback:(s:string)=>void) : void => fs.lstatSync(dir).isDirectory()
	? fs.readdirSync(dir).forEach(f => walkSync(path.join(dir, f), callback))
	: callback(dir);

const pdfPageRx = /^(.*\.pdf)\.(\d+)\.(png|tif)$/;

const tile = (destDir: string, file:string, format:FormatType) : Promise<TileResult> => new Promise((ok, err) => {
	sharp(file, {
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
) : Promise<ImageInfo> {
	const isOmni = type=='omni';
	const isPdfPage = pdfPageRx.test(f);

	if(!fs.existsSync(f)) throw new Error(`File '${f}' not found`);

	const fName = isPdfPage ? f.replace(/\.(tif|png)$/,'') : f;

	const res = omniId ? {id: omniId} : await api<{id:string}>(uploader.agent, `/api/cli${folder}/create`,{
		name: encodeURIComponent(fName), type, format
	});
	if(!res) throw new Error('Could not create image in Micrio! Do you have the correct permissions?');

	outDir = sanitize(outDir,outDir)
	const baseDir = path.join(outDir, res.id, isOmni ? idx.toString() : '');

	const {width, height} = await tile(baseDir, f, format);
	if(!height || !width) throw new Error('Could not read image dimensions');

	if(isPdfPage) fs.rmSync(f);

	fs.renameSync(baseDir+'_files', baseDir);
	fs.rmSync(path.join(baseDir, 'vips-properties.xml'));

	// Update status
	if(!omniId) await api(uploader.agent, `/api/cli${folder}/@${res.id}/status`, {
		width, height, status: 6, format, length: total
	});

	const tiles:string[] = [];
	walkSync(baseDir, t => tiles.push(t));
	uploader.add(tiles);

	// Finalize
	if(type != 'omni') uploader.add([() => api(uploader.agent, `/api/cli${folder}/@${res.id}/status`, { status: 4 })]);

	fs.rmSync(baseDir+'.dzi');

	return { id: res.id, width, height };
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

type JobType = string|(() => Promise<any>);

class Uploader {
	private jobs:JobType[] = [];
	private oncomplete:Function|undefined;
	private uris:{[key:string]:string|Promise<void>} = {};

	running:Map<JobType, Promise<any>> = new Map();
	errored:Map<JobType, number> = new Map();

	constructor(
		public agent:https.Agent,
		private folder:string,
		private format:FormatType,
		private outDir:string
	) {
		this.outDir = sanitize(outDir, outDir);
	}

	add(jobs:JobType[]) {
		this.jobs.push(...jobs);
		this.nextBatch();
	}

	complete() : Promise<void> { return new Promise(ok => {
		if(this.jobs.length+this.running.size == 0) return ok();
		this.oncomplete = ok;
	}) }

	private getUploadUris(first?:string) : Promise<void>|void {
		const files = this.jobs.filter(t => !(t instanceof Function || this.uris[t])).slice(0, SIGNED_URIS - (first ? 1 : 0)) as string[];
		if(first) files.unshift(first);
		if(!files.length) return;
		const call = api<R2StoreResult>(this.agent, `/api/${this.folder.split('/')[1]}/store`, {files : files.map(f => sanitize(f, this.outDir))})
			.catch(e => { throw new Error('Upload error: '+(e.message ?? 'Upload permission denied')) })
			.then(r => { if(!r) throw new Error('Upload permission denied.');
				r.keys.forEach((sig,i) => this.uris[files[i]] = `https://${r.r2Base}.r2.cloudflarestorage.com/${sanitize(files[i], this.outDir)}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=${r.key}%2F${r.time.slice(0,8)}%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=${r.time}&X-Amz-Expires=300&X-Amz-Signature=${sig}&X-Amz-SignedHeaders=host&x-id=PutObject`);
			});
		files.forEach(f => this.uris[f] = call);
	}

	private async getUploadUri(f:string) : Promise<string> {
		if(!this.uris[f]) await this.getUploadUris(f);
		if(this.uris[f] instanceof Promise) await this.uris[f];
		return this.uris[f] as string;
	}

	private nextBatch() {
		let r = UPLOAD_THREADS - this.running.size;
		while(--r > 0) this.next();
	}

	private async next() {
		if(this.running.size >= UPLOAD_THREADS) return;
		const job = this.jobs.shift();
		if(!job) return;
		this.running.set(job, (job instanceof Function ? job() : this.getUploadUri(job).then(uri => this.upload(uri!, job)))
		.catch((e) => {
			const numErrored = (this.errored.get(job) ?? 0) + 1;
			this.errored.set(job, numErrored);
			if(numErrored > NUM_UPLOAD_TRIES)
				throw new Error(`Fatal error: could not ${job instanceof Function ? 'finalize upload' : `upload ${job}`} after ${NUM_UPLOAD_TRIES} tries. (${e?.message ?? 'Error'})`);
			// Try again
			this.jobs.push(job);
		}).then(() => {
			this.running.delete(job)
			if(typeof job == 'string') delete this.uris[job];
			const remaining = this.jobs.length+this.running.size
			if(this.oncomplete) log(`Remaining uploads: ${remaining}...`, 0);
			if(this.jobs.length) this.nextBatch();
			else if(!remaining) this.oncomplete?.();
		}));
	}

	private async upload(_url:string, path:string) : Promise<void> { return new Promise((ok, err) => {
		const url = new URL(_url);
		const blob = fs.readFileSync(path);
		const req = https.request({
			host: url.host,
			path: url.pathname+url.search,
			method: 'PUT',
			agent: this.agent,
			headers: {
				'Content-Type': `image/${this.format}`,
				'Content-Length': blob.byteLength,
			}
		}, res => {
			req.destroy();
			if(res.statusCode == 200) ok();
			else err(new Error(res.statusCode+': '+res.statusMessage));
		});
		req.on('error', (e) => {
			req.destroy();
			err(e);
		});
		req.write(blob);
		req.end();
	})}
}
