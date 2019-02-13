#!/usr/bin/env node
global.Promise = require("bluebird");
import yargs = require("yargs");
import {IPackageJSON} from "./lib/package";
import {readFileSync} from "fs";
import AWS = require("aws-sdk");
import {join} from "path";
import {init, unregister, update} from "./scripts/alb";
import {deleteConfig, getConfig, listConfig, updateConfig} from "./scripts/config";
import {updateBaseMappings} from "./scripts/baseMappings";

function setup(dir: string, region: string): {pkgJson: IPackageJSON} {
	AWS.config.update({
		region,
	});

	try {
		return {pkgJson: JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))};
	} catch (err) {
		console.error("Could not parse project package.json");
		process.exit();
	}
}

yargs.option("projectDirectory", {
	alias: "p",
	desc: "Path to project directory, defaults to cwd",
	default: process.cwd(),
	type: "string",
});
yargs.option("region", {
	alias: "r",
	default: process.env.AWS_REGION || "us-east-1",
	type: "string",
	desc: "The aws region to access",
});

yargs.command("config", "Configuration management commands", (inst) => {
	inst.command("list", "List available configuration environments", {}, async (args) => {
		const setupContent = setup(args.projectDirectory, args.region);
		// console.log(args);
		await listConfig(setupContent.pkgJson);
	});
	inst.command("update", "Update/create a configuration for a given environment", (updateCmd) => {
		updateCmd.option("env", {
			alias: "s",
			required: true,
			type: "string",
			desc: "The config environment to access",
		});

		return updateCmd;
	}, async (args) => {
		const setupContent = setup(args.projectDirectory, args.region);
		// console.log(args);
		await updateConfig(args.env, args.projectDirectory, setupContent.pkgJson);
	});
	inst.command("get", "Retrieve a configuration for a given environment", (getCmd) => {
		getCmd.option("env", {
			alias: "s",
			required: true,
			type: "string",
			desc: "The config environment to access",
		});
		return getCmd;
	}, async (args) => {
		const setupContent = setup(args.projectDirectory, args.region);
		// console.log(args);
		await getConfig(args.env, args.projectDirectory, setupContent.pkgJson);
	});
	inst.command("delete", "Remove a configuration for a given environment", (delCmd) => {
		delCmd.option("env", {
			alias: "s",
			required: true,
			type: "string",
			desc: "The config environment to access",
		});
		return delCmd;
	}, async (args) => {
		const setupContent = setup(args.projectDirectory, args.region);
		// console.log(args);
		await deleteConfig(args.env, args.projectDirectory, setupContent.pkgJson);
	});
	inst.demandCommand();
	return inst;
});

yargs.command("api", "Api management commands", (inst) => {
	inst.command("update-base-mappings", "Updates base path mappings in api gateway for a claudia based api", {}, async (args) => {
		const setupContent = setup(args.projectDirectory, args.region);

		await updateBaseMappings(args.env, args.projectDirectory, setupContent.pkgJson);
	});

	inst.demandCommand();
	return inst;
});

yargs.command("alb", "Manage ALB's and associated lambda targets", (inst) => {
	inst.command("init", "Initialize an alb and lambda target", (initCommand) => {
		return initCommand;
	}, async (args) => {
		const setupContent = setup(args.projectDirectory, args.region);

		await init(args.projectDirectory, setupContent.pkgJson);
	});
	inst.command("update", "Update function code and ALB routes", (updateCommand) => {
		updateCommand.option("stage", {
			alias: "s",
			required: true,
			type: "string",
			desc: "The stage to use for deployment ex: dev",
		});
		return updateCommand;
	}, async (args) => {
		const setupContent = setup(args.projectDirectory, args.region);

		await update(args.stage, args.projectDirectory, setupContent.pkgJson);
	});
	inst.command("deregister", "Deregister an ALB route", (deregisterCommand) => {
		deregisterCommand.option("stage", {
			alias: "s",
			required: true,
			type: "string",
			desc: "The stage to use for deployment ex: dev",
		});
		return deregisterCommand;
	}, async (args) => {
		const setupContent = setup(args.projectDirectory, args.region);

		await unregister(args.stage, args.projectDirectory, setupContent.pkgJson);
	});
	inst.demandCommand();
	return inst;
});

yargs.demandCommand()
	.parse();
