#! /usr/bin/env node

import { program } from 'commander';
import { login } from './commands/login.js';
import chalk from 'chalk';
import { conf } from './lib/store.js';
import { upload } from './commands/upload.js';

let account = conf.get('account');

console.log(chalk.hex('#c5ff5b')('<> Micrio CLI Tool'));
console.log();
if(account) {
	console.log(chalk.hex('#00d4ee')('Logged in as ') + chalk.whiteBright(account.email))
	console.log();
}

program.name('micrio')
	.description('Local image processing and uploader to the Micrio dashboard')
	.version('0.1.0');

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

program.command('upload')
	.description('Upload your images to the Micrio dashboard')
	.argument('<files>', 'One or more image files')
	.requiredOption('--target <url>', 'The Micrio dashboard url of the target folder')
	.action(upload);

program.parse();
