import { createGUID } from '../lib/utils.js';
import { conf, urlAccountBase } from '../lib/store.js';
import fetch from 'node-fetch';

let account = conf.get('account');

const to = (fn:(()=>any)|undefined,ms:number=1000) : Promise<void> => new Promise(ok => setTimeout(async () => {await fn?.();ok()}, ms));

export interface UserToken {
	email: string;
	base64: string;
	expires: Date;
}
interface LoginStatusResult {
	status: ('ok'|'wait'|'error');
	token?: UserToken;
};

export async function login() {
	const id = createGUID();

	async function check() : Promise<LoginStatusResult> { return new Promise(async (ok, err) => { do {
		const resp = await fetch(`${urlAccountBase}/api/cli/${id}/status`).then(r => r?.ok && r.status == 200 ? r.json() : {status:'error'}) as LoginStatusResult;
		if(resp.status == 'ok') return ok(resp);
		else if(resp.status == 'error') return err(resp);
		else await to(undefined, 3000);
	} while(true)})}

	if(await fetch(`${urlAccountBase}/api/cli/${id}/create`).then(r => r.text()) == 'OK') {
		console.log('Go to the following url to continue the login process:');
		console.log();
		console.log(` > ${urlAccountBase}/cli-login/${id}`);

		check().then((r) => {
			conf.set('account', account = r.token!);
			console.log();
			console.log('Succesfully logged in as ' + r.token!.email +'.');
		}, () => {
			console.log();
			console.log('Could not log in. Please try again.');
		})
	}
	else console.log('Something went wrong. Please try again later.')
}
