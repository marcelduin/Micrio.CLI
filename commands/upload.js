import fs from 'fs';
import hasbin from 'hasbin';
import { urlDashBase, conf } from '../lib/store.js';
import chalk from 'chalk';
import { execSync } from 'child_process';
import path from 'path';

const account = conf.get('account');

const api = (path) => fetch(urlDashBase+path,{
	headers: { Cookie: `.AspNetCore.Identity.Application=${account.base64};`}
}).then(r => r?.ok && r.status == 200 ? r.json() : undefined, () => undefined);

const error = (str) => console.log(chalk.red('error: ' + str));

export async function upload(attr, opts) {
	if(!account?.email) return error(`Not logged in. Run 'micrio login' first`);

	if(!hasbin.sync('vips')) return error('Libvips not installed. Download it from https://www.libvips.org/install.html');

	let url;
	try { url = new URL(opts.target) } catch(e) {
		return error('Invalid target URL. This has to be the full URL of the target folder of the Micrio dashboard (https://dash.micr.io/...)');
	}

	const start = Date.now();
	const files = attr.split(' ');
	for(const f of files) try { await handle(f, url.pathname) } catch(e) {
		return error(e?.message??e??'An unknown error occurred');
	}

	console.log(`Succesfully completed in ${Math.round(Date.now()-start)/1000}s.`);
}

const SIGNED_URIS = 20;
const UPLOAD_THREADS = 10;

const walkSync = (dir, callback) =>  fs.lstatSync(dir).isDirectory()
	? fs.readdirSync(dir).map(f => walkSync(path.join(dir, f), callback))
	: callback(dir);

async function handle(f, folder) {
	if(!fs.existsSync(f)) throw new Error(`File '${f}' not found`);

	console.log(`Starting '${f}'`);

	const res = await api(`/api/cli${folder}/create?f=${encodeURIComponent(f)}`);
	if(!res) throw new Error('Could not create image in Micrio! Do you have the correct permissions?');

	console.log('Processing... this could take a while depending on the image size.');
	execSync(`vips dzsave ${f}[0] ${res.id} --layout dz --tile-size 1024 --overlap 0 --suffix .webp[Q=85] --strip`);
	fs.renameSync(res.id+'_files', res.id);

	const [,height,width] = /Height\="(\d+)"\n.*Width\="(\d+)"/m.exec(fs.readFileSync(res.id+'.dzi', 'utf-8'));

	const tiles = [];
	const uploadUris = [];
	walkSync(res.id, t => tiles.push(t));

	async function getUploadUris() {
		const files = tiles.slice(0, SIGNED_URIS);
		if(files.length) uploadUris.push(...await api(`/api/${folder.split('/')[1]}/store?f=${files.map(f => f.replace(/\\/g,'/')).join(',')}`).then(r =>
			r.keys.map((sig,i) => `https://micrio.${r.account}.r2.cloudflarestorage.com/${files[i]}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=${r.key}%2F${r.time.slice(0,8)}%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=${r.time}&X-Amz-Expires=300&X-Amz-Signature=${sig}&X-Amz-SignedHeaders=host&x-id=PutObject`)
		));
	}

	const total = tiles.length;
	let count = 0;
	const running = {};

	while(tiles.length) {
		const queue = Object.values(running);
		if(queue.length >= UPLOAD_THREADS) await Promise.any(queue);
		if(!uploadUris.length) await getUploadUris();
		log(`Uploading ${++count} / ${total}...`, true);
		const tile = tiles.shift();
		running[tile] = fetch(uploadUris.shift(), {
			method: 'PUT',
			body: new Blob([fs.readFileSync(tile)], {type: 'image/webp'}),
			headers: { 'Content-Type': 'image/webp' }
		}).then(() => delete running[tile]);
	}

	// Finalize
	await api(`/api/cli${folder}/@${res.id}?w=${width}&h=${height}`);

	process.stdout.clearLine(0);
	console.log('Upload complete.')

	fs.rmSync(res.id, {recursive: true, force: true});
	fs.rmSync(res.id+'.dzi');

	console.log();
}

function log(str, overwrite=false) {
	if(overwrite) {
		process.stdout.clearLine(0);
		process.stdout.cursorTo(0);
	}
	process.stdout.write(str + (overwrite ? '\r' : '\n'));
}
