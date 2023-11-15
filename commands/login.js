import chalk from 'chalk';

import { createGUID } from '../lib/utils.js';
import { conf, urlAccountBase } from '../lib/store.js';

let account = conf.get('account');

const to = (fn,ms=1000) => new Promise(ok => setTimeout(async () => {await fn?.();ok()}, ms));

export async function login() {
	const id = createGUID();

	async function check() { return new Promise(async (ok, err) => { do {
		const resp = await fetch(`${urlAccountBase}/api/cli/${id}/status`).then(r => r?.ok && r.status == 200 ? r.json() : {status:'error'});
		if(resp.status == 'ok') return ok(resp);
		else if(resp.status == 'error') return err(resp);
		else await to(undefined, 3000);
	} while(true)})}

	if(await fetch(`${urlAccountBase}/api/cli/${id}/create`).then(r => r.text()) == 'OK') {
		console.log('Go to the following url to continue the login process:');
		console.log();
		console.log(chalk.whiteBright.bold(` > ${urlAccountBase}/cli-login/${id}`));

		check().then((r) => {
			conf.set('account', account = r.token);
			console.log();
			console.log('Succesfully logged in as ' + chalk.whiteBright(r.token.email) +'.');
		}, () => {
			console.log();
			console.log(chalk.red('Could not log in. Please try again.'));
		})
	}
	else console.log('Something went wrong. Please try again later.')
}
