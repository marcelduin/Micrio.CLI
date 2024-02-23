#! /usr/bin/env node

import { program, Option } from 'commander';
import { UserToken, login } from './commands/login.js';
import { conf } from './lib/store.js';
import { upload } from './commands/upload.js';
import process from 'process';

const nodeVersion = Number(process.version.split('.')[0].replace('v',''));
if(isNaN(nodeVersion) || nodeVersion < 18) {
	console.log(`ERROR: Micrio.CLI requires NodeJS v18.0.0+ to run. Your current version is ${process.version}.`);
	console.log('');
	console.log('Please update your NodeJS at https://nodejs.org/');
	process.exit(1);
}

let account = conf.get('account') as UserToken|undefined;

console.log('<> Micrio CLI Tool');
console.log();
if(account) {
	console.log('Logged in as ' + account.email)
	console.log();
}

program.name('micrio')
	.description('Local image processing and uploader to the Micrio dashboard')
	.version('1.2.0');

program.command('login')
	.description('connect to your current Micrio session')
	.action(login);

program.command('logout')
	.description('log out of your Micrio account for this tool')
	.action(() => {
		if(account) {
			conf.delete('account');
			console.log('Succesfully logged out.');
		}
		else console.log('Not logged in.')
	});

program.command('upload')
	.description('upload your images to the Micrio dashboard')
	.argument('<files>', 'one or more image files, wildcards supported (such as *.jpg)')
	.requiredOption('-d, --destination <url>', 'the Micrio dashboard destination folder URL')
	.addOption(new Option('-f, --format <format>', 'tile format').choices(['webp', 'jpg']).default('webp'))
	.addOption(new Option('-t, --type <type>', 'image type').choices(['2d', '360', 'omni']).default('2d'))
	.addOption(new Option('--dpi <dpi>', 'PDF DPI').default('150'))
	.action(upload);

program.parse();
