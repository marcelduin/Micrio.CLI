#! /usr/bin/env node

import { program } from 'commander';
import { login } from './commands/login.js';
import chalk from 'chalk';
import { conf } from './lib/store.js';

let account = conf.get('account');

console.log('Micrio CLI Tool'+(account ? ' [' + chalk.whiteBright(account.email) + ']' : ''));
console.log();

program.command('login')
	.description('Connect to your current Micrio session')
	.action(login);

program.command('logout')
	.description('Log out of your Micrio account for this tool')
	.action(() => {
		if(account) {
			conf.delete('account');
			console.log('Succesfully logged out.');
		}
		else console.log('Not logged in.')
	});

program.parse();
