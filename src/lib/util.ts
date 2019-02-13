import {existsSync, readdirSync, readFileSync, statSync, writeFileSync} from "fs";
import {join, relative} from "path";
import {promisify} from "util";
import zip = require("jszip");

const pathParseReg = /\/([\S]+?)\/([\S]+?)\/([\S]*)/g;
const templateReg = /\{([a-zA-Z1-9]+?)\}/g;
export const asyncTimeout = promisify(setTimeout);
export const SID_PREFIX = "APINPM";

export interface PolicySidData {
	loadBalancer: string;
	path: string;
}

export function getParamName(env: string, pkgVersion: string, pkgName: string) {
	return `/${pkgName}/${pkgVersion}/${env}`;
}

export function parseParamName(name: string): { pkg: string, version: string, env: string } {
	pathParseReg.lastIndex = 0;
	const res = pathParseReg.exec(name);
	return {
		pkg: res[1],
		version: res[2],
		env: res[3],
	};
}

export function getConfigProperty(prop: string, dir: string): any | null {
	const path = (existsSync(join(dir, `${prop}.json`))) ? join(dir, `${prop}.json`) : join(dir, "config.json");
	try {
		const data = JSON.parse(readFileSync(path, "utf8"));
		return data[prop];
	} catch (e) {
		return null;
	}
}

export function setConfigProperty(prop: string, obj: any, dir: string) {
	let data: any;
	let path: string;
	if (existsSync(join(dir, `${prop}.json`))) {
		path = join(dir, `${prop}.json`);
		data = JSON.parse(readFileSync(path, "utf8"));
	} else if (existsSync(join(dir, "config.json"))) {
		path = join(dir, "config.json");
		data = JSON.parse(readFileSync(path, "utf8"));
	} else {
		path = join(dir, `${prop}.json`);
		data = {};
	}
	// const path = (existsSync(join(dir, `${prop}.json`))) ? join(dir, `${prop}.json`) : join(dir, "config.json");
	data[prop] = obj;
	writeFileSync(path, JSON.stringify(data, null, 2));
}

export function simpleTemplate(template: string, replacements: {[key: string]: string }) {
	return template.replace(templateReg, (match, key) => {
		const rep = replacements[key];
		if (rep == null) {
			throw Error("Invalid template key");
		} else {
			return rep;
		}
	});
}

export function zipDir(dir: string): Promise<Uint8Array> {
	const zippy = new zip();
	walkDir(dir, (path) => {
		zippy.file(relative(dir, path), readFileSync(path));
	});
	return zippy.generateAsync({type: "uint8array"});
}

export function walkDir(dir: string, callback: (dir: string) => void) {
	const contents = readdirSync(dir);
	contents.forEach((item) => {
		const path = join(dir, item);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			walkDir(path, callback);
		} else {
			callback(path);
		}
	});
}

export function serializePolicySid(data: PolicySidData) {
	return `${SID_PREFIX}:${data.loadBalancer}:${data.path}`;
}

export function deserializePolicySid(sid: string): PolicySidData {
	if (!sid.startsWith(SID_PREFIX)) {
		return null;
	} else {
		const data = sid.split(":");
		if (data.length !== 3) {
			return null;
		}
		return {
			loadBalancer: data[1],
			path: data[2],
		};
	}
}