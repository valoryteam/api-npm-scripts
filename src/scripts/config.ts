import {IPackageJSON} from "../lib/package";
import {SSM} from "aws-sdk";
import {existsSync, readFileSync, writeFileSync} from "fs";
import {join} from "path";
import {
	DeleteParameterRequest,
	GetParameterRequest,
	GetParametersByPathRequest,
	PutParameterRequest,
} from "aws-sdk/clients/ssm";
import {getParamName, parseParamName} from "../lib/util";
import * as zlib from "zlib";

export interface MergeableConfig {
	name: string;
	propsToMerge: string[];
}

const MergeableConfigs: MergeableConfig[] = [
	{
		name: "claudia.json",
		propsToMerge: ["api", "lambda"],
	},
	{
		name: "alb.json",
		propsToMerge: ["alb"],
	},
];

export function mergeConfig(mergeable: MergeableConfig, dir: string, config: any): boolean {
	const path = join(dir, mergeable.name);
	if (path && mergeable.propsToMerge.every((prop) => config[prop] == null) && existsSync(path)) {
		console.log(`Found external config "${mergeable.name}"; merging`);
		try {
			const data = JSON.parse(readFileSync(path, "utf8"));
			const isValid = mergeable.propsToMerge.every((prop) => data[prop] != null);
			if (!isValid) {
				throw Error("Config is corrupt");
			}
			mergeable.propsToMerge.forEach((prop) => {
				config[prop] = data[prop];
			});
			console.log("Saving modified config locally");
			writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
			return true;
		} catch (e) {
			console.error("Could not load external config");
			console.error(e);
			return false;
		}
	} else {
		return true;
	}
}

export async function updateConfig(env: string, dir: string, pkg: IPackageJSON) {
	const SSMClient = new SSM();
	let config: any;
	console.log("Loading config file");
	try {
		config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
	} catch (err) {
		console.error(`Could not load config.json from ${dir}`);
		console.error(err);
		return;
	}

	const configStr = MergeableConfigs.every((ext) => mergeConfig(ext, dir, config));

	if (configStr === false) {
		return;
	}

	console.log("Zipping config");
	const zipped = zlib.deflateRawSync(JSON.stringify(config)).toString("base64");

	const putRequest: PutParameterRequest = {
		Overwrite: true,
		Name: getParamName(env, pkg.version, pkg.name),
		Value: zipped,
		Description: `${pkg.name} configuration for env ${env}`,
		Type: "String",
	};

	console.log(`Config size:  bytes: ${Buffer.byteLength(putRequest.Value)}, length: ${putRequest.Value.length}`);

	if (putRequest.Value.length >= 4096) {
		console.error("Config is too large, the maximum supported Parameter Store size is 4096");
		return;
	}

	console.log("Saving config");
	try {
		await SSMClient.putParameter(putRequest).promise();
	} catch (err) {
		console.error("Could not save config");
		console.error(err);
		return;
	}
	console.log("Done");
}

export async function getConfig(env: string, dir: string, pkg: IPackageJSON) {
	const SSMClient = new SSM();
	const getRequest: GetParameterRequest = {
		Name: getParamName(env, pkg.version, pkg.name),
		WithDecryption: true,
	};

	console.log("Retrieving config");
	try {
		const config = await SSMClient.getParameter(getRequest).promise();
		console.log("Unzipping config");
		const unzipped = zlib.inflateRawSync(Buffer.from(config.Parameter.Value, "base64")).toString("utf8");
		writeFileSync(join(dir, "config.json"), JSON.stringify(JSON.parse(unzipped), null, 2));
	} catch (err) {
		if (err.code === "ParameterNotFound") {
			console.error(`Config env "${env}" does not exist for version ${pkg.version}`);
			return;
		}
		console.error("Could not retrieve config");
		console.error(err);
		return;
	}
	console.log("Done");
}

export async function listConfig(pkg: IPackageJSON) {
	const SSMClient = new SSM();
	const getRecursiveRequest: GetParametersByPathRequest = {
		Recursive: true,
		Path: `/${pkg.name}`,
	};
	console.log("Loading supported configurations");

	try {
		const params = await SSMClient.getParametersByPath(getRecursiveRequest).promise();
		const configs: {[version: string]: string[]} = {};
		if (params.Parameters.length === 0) {
			console.log("No configurations exist for this package");
			return;
		}
		params.Parameters.forEach((param) => {
			const info = parseParamName(param.Name);
			if (configs[info.version] == null) {
				configs[info.version] = [];
			}
			configs[info.version].push(info.env);
		});
		console.log(`${pkg.name} suppports the following versions and environments: ${JSON.stringify(configs, null, 2)}`);
		return;
	} catch (err) {
		console.error("Could not retrieve configs for project");
		console.error(err);
		return;
	}
}

export async function deleteConfig(env: string, dir: string, pkg: IPackageJSON) {
	const SSMClient = new SSM();
	const delRequest: DeleteParameterRequest = {
		Name: getParamName(env, pkg.version, pkg.name),
	};

	console.log("Deleting config");
	try {
		await SSMClient.deleteParameter(delRequest).promise();
	} catch (err) {
		console.error("Could not delete config");
		console.error(err);
		return;
	}
	console.log("Done");
}
