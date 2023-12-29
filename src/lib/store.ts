import Conf from 'conf';

const dev = false;
export const conf = new Conf({projectName: 'Micrio'+(dev?'-dev':'')});

export const urlAccountBase = dev ? 'http://localhost:6200' : 'https://account.micr.io';
export const urlDashBase = dev ? 'http://localhost:6100' : 'https://dash.micr.io';
