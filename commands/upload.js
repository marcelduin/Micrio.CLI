import fs from 'fs';
import hasbin from 'hasbin';
import { urlDashBase, conf } from '../lib/store.js';
import chalk from 'chalk';
import { execSync } from 'child_process';
import path from 'path';

const account = conf.get('account');

const api = (path) => fetch(urlDashBase+path,{
	headers: { Cookie: `.AspNetCore.Identity.Application=${account.base64};`}
}).then(r => r?.json(), () => undefined).then(r => {
	if(r?.error) throw new Error(r.error);
	return r;
});

const error = (str) => console.log(chalk.red('Error: ') + str);
const sanitize = (f, outDir) => f.replace(/\\+/g,'/').replace(outDir+'/','');

export async function upload(attr, opts) {
	if(!account?.email) return error(`Not logged in. Run 'micrio login' first`);

	if(!hasbin.sync('vips')) return error('Libvips not installed. Download it from https://www.libvips.org/install.html');

	let url;
	try { url = new URL(opts.destination) } catch(e) {
		return error('Invalid target URL. This has to be the full URL of the target folder of the Micrio dashboard (https://dash.micr.io/...)');
	}

	const folder = url.pathname;

	const start = Date.now();

	const allFiles = fs.readdirSync('.').filter(f => !fs.lstatSync(f).isDirectory());
	let files = attr.split(' ').map(f => {
		if(!/\*/.test(f)) return [f]
		const rx = new RegExp(f.replace(/\./g,'\\.').replace(/\*/g,'.+'), 'i');
		return allFiles.filter(f => rx.test(f));
	}).reduce((a, b) => [...a,...b], []).sort((a, b) => a > b ? 1 : a < b ? -1 : 0);
	files = files.filter((f,i) => files.indexOf(f) == i);

	if(!files.length) return error('No images to process');

	const outDir = '_micrio_'+Math.floor(Math.random()*10000000);

	if(!fs.existsSync(outDir)) fs.mkdirSync(outDir);

	const numLen = (files.length+'').length;
	const strLen = 4 + numLen * 2 + Math.max(...files.map(f => f.length));

	let omniId;

	for(let i=0;i<files.length;i++) try {
		await handle(files[i], outDir, folder, opts.format, opts.type, i, files.length, strLen, omniId, id => omniId = id);
	} catch(e) {
		return error(e?.message??e??'An unknown error occurred');
	}

	if(omniId) {
		console.log('Creating optimized viewing package...');
		const tiles = [];
		walkSync('basebin', t => tiles.push({
			path: t.replace(/\\/g,'/').replace('basebin/',''),
			buffer: fs.readFileSync(t)
		}));
		const path = `${omniId}/base.bin`;
		const postUri = await api(`/api/${url.pathname.split('/')[1]}/store?f=${path}`).then(r => {
			if(!r) throw new Error('Upload permission denied.');
			return r.keys.map((sig,i) => `https://micrio.${r.account}.r2.cloudflarestorage.com/${path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=${r.key}%2F${r.time.slice(0,8)}%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=${r.time}&X-Amz-Expires=300&X-Amz-Signature=${sig}&X-Amz-SignedHeaders=host&x-id=PutObject`)
		});
		await fetch(postUri[0], {
			method: 'PUT',
			body: generateMDP(tiles),
			headers: { 'Content-Type': 'application/octet-stream' }
		});
		fs.rmSync('basebin', {recursive: true, force: true});
		console.log('Done.');
	}

	const allTiles = [];
	const uploadUris = [];
	walkSync(outDir, t => allTiles.push(t));
	const total = allTiles.length;
	let count = 0;
	const running = {};

	async function getUploadUris() {
		const files = allTiles.slice(0, SIGNED_URIS);
		if(files.length) uploadUris.push(...await api(`/api/${folder.split('/')[1]}/store?f=${files.map(f => sanitize(f, outDir)).join(',')}`).then(r => {
			if(!r) throw new Error('Upload permission denied.');
			return r.keys.map((sig,i) => `https://micrio.${r.account}.r2.cloudflarestorage.com/${sanitize(files[i], outDir)}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=${r.key}%2F${r.time.slice(0,8)}%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=${r.time}&X-Amz-Expires=300&X-Amz-Signature=${sig}&X-Amz-SignedHeaders=host&x-id=PutObject`)
		}));
	}

	while(allTiles.length) {
		const queue = Object.values(running);
		if(queue.length >= UPLOAD_THREADS) await Promise.any(queue);
		if(!uploadUris.length) await getUploadUris();

		const tile = allTiles.shift();
		log(`Uploading ${++count} / ${total}...`, 0);
		running[tile] = fetch(uploadUris.shift(), {
			method: 'PUT',
			body: new Blob([fs.readFileSync(tile)], {type: `image/${opts.format}`}),
			headers: { 'Content-Type': `image/${opts.format}` }
		}).then(() => delete running[tile]);
	}

	// Finish remaining
	await Promise.all(Object.values(running));

	fs.rmSync(outDir, {recursive: true, force: true});

	log(`Succesfully uploaded ${files.length} image${files.length==1?'':'s'} in ${Math.round(Date.now()-start)/1000}s.`, 0);
	console.log();
}

const SIGNED_URIS = 20;
const UPLOAD_THREADS = 10;

const walkSync = (dir, callback) =>  fs.lstatSync(dir).isDirectory()
	? fs.readdirSync(dir).map(f => walkSync(path.join(dir, f), callback))
	: callback(dir);

async function handle(f, outDir, folder, format, type, idx, length, pos, omniId, setOmniId) {
	if(!fs.existsSync(f)) throw new Error(`File '${f}' not found`);

	const res = omniId ? {id: omniId} : await api(`/api/cli${folder}/create?f=${encodeURIComponent(f)}&t=${type}`);
	if(!res) throw new Error('Could not create image in Micrio! Do you have the correct permissions?');

	log(`Processing ${idx+1} / ${length}...`, 0);
	execSync(`vips dzsave ${f}[0] ${outDir}/${res.id} --layout dz --tile-size 1024 --overlap 0 --suffix .${format}[Q=${format == 'webp' ? '75' : '85'}] --strip`);

	const isOmni = type=='omni';
	if(isOmni) {
		if(!omniId) setOmniId(outDir + '/' + res.id);
		fs.mkdirSync(outDir + '/' + res.id);
		fs.renameSync(outDir + '/' + res.id+'_files', outDir+'/'+res.id+'/'+idx);
	}
	else fs.renameSync(outDir + '/' + res.id+'_files', outDir+'/'+res.id);

	const [,height,width] = /Height\="(\d+)"\n.*Width\="(\d+)"/m.exec(fs.readFileSync(outDir+'/'+res.id+'.dzi', 'utf-8'));

	// Finalize
	if(!omniId) {
		await api(`/api/cli${folder}/@${res.id}?w=${width}&h=${height}&f=${format}&l=${length}`);
		if(isOmni && !fs.existsSync('basebin')) fs.mkdirSync('basebin');
	}

	// Move tile for base.bin generation
	if(isOmni) {
		let d = Math.max(width, height), l = 0;
		while(d > 1024) { d /= 2; l++; }
		let dzLevels = 0, max = Math.max(width, height);
		do dzLevels++; while ((max /= 2) > 1);
		fs.mkdirSync('basebin/'+idx);
		fs.renameSync(`${outDir}/${res.id}/${idx}/${dzLevels - l}`, `basebin/${idx}/${dzLevels - l}`);
	}

	fs.rmSync(outDir+'/'+res.id+'.dzi');
}

function log(str, pos, newLine) {
	if(!newLine) newLine = pos == undefined;
	if(!newLine) {
		process.stdout.cursorTo(pos ?? 0);
		process.stdout.clearLine(1);
	}
	process.stdout.write((pos?' | ':'') + str + (newLine ? '\n' : '\r'));
}

function generateMDP(images) {
	const enc = new TextEncoder();
	const arr = [];
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
