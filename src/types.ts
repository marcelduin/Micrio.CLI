export interface R2StoreResult {
	time: string;
	key: string;
	account: string;
	r2Base: string;
	keys: string[];
};

export type FormatType = ('jpg'|'webp'|'png');
export type ImageType = ('2d'|'360'|'omni');

export interface ImageInfo {
	id: string;
	width: number;
	height: number;
};

export interface TileResult {
	width: number;
	height: number;
}

export interface UserToken {
	email: string;
	base64: string;
	expires: Date;
}
export interface LoginStatusResult {
	status: ('ok'|'wait'|'error');
	token?: UserToken;
}
