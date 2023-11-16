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

export async function upload(attr, opts) {
	if(!account?.email) return error(`Not logged in. Run 'micrio login' first`);

	if(!hasbin.sync('vips')) return error('Libvips not installed. Download it from https://www.libvips.org/install.html');

	let url;
	try { url = new URL(opts.destination) } catch(e) {
		return error('Invalid target URL. This has to be the full URL of the target folder of the Micrio dashboard (https://dash.micr.io/...)');
	}

	const start = Date.now();

	const allFiles = fs.readdirSync('.').filter(f => !fs.lstatSync(f).isDirectory());
	let files = attr.split(' ').map(f => {
		if(!/\*/.test(f)) return [f]
		const rx = new RegExp(f.replace(/\./g,'\\.').replace(/\*/g,'.+'), 'i');
		return allFiles.filter(f => rx.test(f));
	}).reduce((a, b) => [...a,...b], []).sort((a, b) => a > b ? 1 : a < b ? -1 : 0);
	files = files.filter((f,i) => files.indexOf(f) == i);

	if(!files.length) return error('No images to process');

	const numLen = (files.length+'').length;
	const strLen = 4 + numLen * 2 + Math.max(...files.map(f => f.length));

	let omniId;

	for(let i=0;i<files.length;i++) try {
		process.stdout.write(`[${(i+1+'').padStart(numLen)}/${files.length}] ${files[i]}\r`);
		await handle(files[i], url.pathname, opts.format, opts.type, i, files.length, strLen, omniId, id => omniId = id);
	} catch(e) {
		return error(e?.message??e??'An unknown error occurred');
	}

	console.log();
	console.log(`Succesfully uploaded ${files.length} image${files.length==1?'':'s'} in ${Math.round(Date.now()-start)/1000}s.`);
}

const SIGNED_URIS = 20;
const UPLOAD_THREADS = 10;

const walkSync = (dir, callback) =>  fs.lstatSync(dir).isDirectory()
	? fs.readdirSync(dir).map(f => walkSync(path.join(dir, f), callback))
	: callback(dir);

async function handle(f, folder, format, type, idx, length, pos, omniId, setOmniId) {
	if(!fs.existsSync(f)) throw new Error(`File '${f}' not found`);

	const res = omniId ? {id: omniId} : await api(`/api/cli${folder}/create?f=${encodeURIComponent(f)}&t=${type}`);
	if(!res) throw new Error('Could not create image in Micrio! Do you have the correct permissions?');

	log('Processing...', pos);
	execSync(`vips dzsave ${f}[0] ${res.id} --layout dz --tile-size 1024 --overlap 0 --suffix .${format}[Q=85] --strip`);

	if(type=='omni') {
		if(!omniId) setOmniId(res.id);
		fs.mkdirSync(res.id);
		fs.renameSync(res.id+'_files', res.id+'/'+idx);
	}
	else fs.renameSync(res.id+'_files', res.id);

	const [,height,width] = /Height\="(\d+)"\n.*Width\="(\d+)"/m.exec(fs.readFileSync(res.id+'.dzi', 'utf-8'));

	const tiles = [];
	const uploadUris = [];
	walkSync(res.id, t => tiles.push(t));

	async function getUploadUris() {
		const files = tiles.slice(0, SIGNED_URIS);
		if(files.length) uploadUris.push(...await api(`/api/${folder.split('/')[1]}/store?f=${files.map(f => f.replace(/\\/g,'/')).join(',')}`).then(r => {
			if(!r) throw new Error('Upload permission denied.');
			return r.keys.map((sig,i) => `https://micrio.${r.account}.r2.cloudflarestorage.com/${files[i]}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=${r.key}%2F${r.time.slice(0,8)}%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=${r.time}&X-Amz-Expires=300&X-Amz-Signature=${sig}&X-Amz-SignedHeaders=host&x-id=PutObject`)
		}));
	}

	const total = tiles.length;
	let count = 0;
	const running = {};

	while(tiles.length) {
		const queue = Object.values(running);
		if(queue.length >= UPLOAD_THREADS) await Promise.any(queue);
		if(!uploadUris.length) await getUploadUris();
		log(`Uploading ${++count} / ${total}...`, pos);
		const tile = tiles.shift();
		running[tile] = fetch(uploadUris.shift(), {
			method: 'PUT',
			body: new Blob([fs.readFileSync(tile)], {type: 'image/webp'}),
			headers: { 'Content-Type': 'image/webp' }
		}).then(() => delete running[tile]);
	}

	// Finalize
	if(!omniId) await api(`/api/cli${folder}/@${res.id}?w=${width}&h=${height}&f=${format}&l=${length}`);

	log('OK', pos, true);

	fs.rmSync(res.id, {recursive: true, force: true});
	fs.rmSync(res.id+'.dzi');
}

function log(str, pos, newLine) {
	process.stdout.cursorTo(pos);
	process.stdout.clearLine(1);
	process.stdout.write(' | ' + str + (newLine ? '\n' : '\r'));
}
