#! /usr/bin/env node

import { program, Option } from 'commander';
import { UserToken, login } from './commands/login.js';
import { conf } from './lib/store.js';
import { upload } from './commands/upload.js';

let account = conf.get('account') as UserToken|undefined;

console.log('<> Micrio CLI Tool');
console.log();
if(account) {
	console.log('Logged in as ' + account.email)
	console.log();
}

program.name('micrio')
	.description('Local image processing and uploader to the Micrio dashboard')
	.version('0.1.0');

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
	.action(upload);

program.parse();