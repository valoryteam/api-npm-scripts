import {EC2, ELBv2, IAM, Lambda} from "aws-sdk";
import {existsSync, statSync} from "fs";
import {prompt} from "inquirer";
import {dirname, extname, join, parse} from "path";
import {IPackageJSON} from "../lib/package";
import {getConfigProperty, setConfigProperty, SID_PREFIX, simpleTemplate, zipDir} from "../lib/util";

const promRetry = require("promise-retry");

export interface ALBConfig {
	serviceName: string;
	pathTemplate: string;
	loadBalancer: string;
	region: string;
	lambda: {
		role: string;
		name: string;
		module: string;
		dir: string;
	};
}

const DefaultLambdaPolicy = {
	Version: "2012-10-17",
	Statement: [
		{
			Effect: "Allow",
			Action: [
				"logs:CreateLogGroup",
				"logs:CreateLogStream",
				"logs:PutLogEvents",
			],
			Resource: "*",
		},
	],
};

const DefaultLambdaRoleAssume = {
	Version: "2012-10-17",
	Statement: [
		{
			Action: "sts:AssumeRole",
			Effect: "Allow",
			Principal: {
				Service: "lambda.amazonaws.com",
			},
		},
	],
};

export async function init(dir: string, pkg: IPackageJSON) {
	if (getConfigProperty("alb", dir) != null) {
		console.error("Config already contains ALB section");
		return;
	}
	console.log("Loading current state");

	const EC2Client = new EC2();
	const ELBClient = new ELBv2();
	const IAMClient = new IAM();
	const LambdaClient = new Lambda();

	const currentSubnets: { [name: string]: EC2.Subnet } = {};
	const currentLoadBalancers: { [name: string]: ELBv2.LoadBalancer } = {};
	const currentSecurityGroups: { [name: string]: EC2.SecurityGroup } = {};
	const currentVPCs: { [name: string]: EC2.Vpc } = {};
	let defaultVpcId: string = "";
	(await ELBClient.describeLoadBalancers({
		PageSize: 100,
	}).promise()).LoadBalancers.forEach((lb) => {
		currentLoadBalancers[lb.LoadBalancerName] = lb;
	});
	(await EC2Client.describeSubnets().promise()).Subnets.forEach((subnet) => {
		currentSubnets[subnet.SubnetId] = subnet;
	});
	(await EC2Client.describeSecurityGroups().promise()).SecurityGroups.forEach((sg) => {
		currentSecurityGroups[sg.GroupId] = sg;
	});
	(await EC2Client.describeVpcs().promise()).Vpcs.forEach((vpc) => {
		currentVPCs[vpc.VpcId] = vpc;
		if (vpc.IsDefault) {
			defaultVpcId = vpc.VpcId;
		}
	});

	const elbQuestions = await prompt([
		{
			name: "loadBalancerName",
			message: "Name of the loadbalancer you want to use",
			validate(lbName) {
				const info = currentLoadBalancers[lbName];
				if (info == null) {
					return true;
				}
				if (info.Type !== "application") {
					return "Existing loadbalancer must be an ALB";
				}
				return true;
			},
		},
		{
			name: "createNew",
			when(args: any) {

				return currentLoadBalancers[args.loadBalancerName] == null;
			},
			message: "This load balancer does not exist. Create it?",
			type: "confirm",
		},
		{
			name: "subnets",
			message: "Subnets for the ALB. May not be from the same AZ. Select at least 2",
			when(args: any) {
				return args.createNew === true;
			},
			type: "checkbox",
			choices(args: any) {
				const res: Array<{ name: string, value: string }> = [];
				Object.keys(currentSubnets).forEach((sub) => {
					const subInfo = currentSubnets[sub];
					if (subInfo.VpcId === defaultVpcId) {
						res.push({
							name: `${sub} - ${subInfo.AvailabilityZone}`,
							value: sub,
						});
					}
				});
				return res;
			},
			validate(subnets: string[]) {
				if (subnets.length < 2) {
					return "Must select at least 2";
				}
				const selectedAZs: string[] = [];
				let dupe = false;
				subnets.forEach((sub) => {
					const subInfo = currentSubnets[sub];
					if (selectedAZs.indexOf(subInfo.AvailabilityZone) === -1) {
						selectedAZs.push(subInfo.AvailabilityZone);
					} else {
						dupe = true;
					}
				});
				if (dupe) {
					return "Only one subnet per AZ";
				} else {
					return true;
				}
			},
		},
		{
			name: "securityGroups",
			message: "Security Groups for the ALB. Must select at at least one.",
			type: "checkbox",
			when(args: any) {
				return args.createNew === true;
			},
			choices(args: any) {
				const res: Array<{ name: string, value: string }> = [];
				Object.keys(currentSecurityGroups).forEach((sg) => {
					const sgInfo = currentSecurityGroups[sg];
					if (sgInfo.VpcId === defaultVpcId) {
						res.push({
							name: `${sg} - ${sgInfo.GroupName}`,
							value: sg,
						});
					}
				});
				return res;
			},
			validate(groups: string[]) {
				if (groups.length < 1) {
					return "Must select at least 1";
				}
				return true;
			},
		},
	]);

	let lbInfo: ELBv2.LoadBalancer;
	// ALB did not exist, and we were told not to create it
	if (elbQuestions.createNew === false) {
		return;
	}

	// Use existing alb
	if (elbQuestions.createNew == null) {
		lbInfo = currentLoadBalancers[elbQuestions.loadBalancerName];
	} else {
		// Create a new ALB
		const ELBCreateRequest: ELBv2.CreateLoadBalancerInput = {
			Name: elbQuestions.loadBalancerName,
			Subnets: elbQuestions.subnets,
			SecurityGroups: elbQuestions.securityGroups,
			Type: "application",
			IpAddressType: "ipv4",
			Scheme: "internet-facing",
		};

		lbInfo = (await ELBClient.createLoadBalancer(ELBCreateRequest).promise()).LoadBalancers[0];

		// add an http listener
		await ELBClient.createListener({
			DefaultActions: [
				{
					Type: "fixed-response",
					FixedResponseConfig: {
						StatusCode: "404",
					},
				},
			],
			Protocol: "HTTP",
			Port: 80,
			LoadBalancerArn: lbInfo.LoadBalancerArn,
		}).promise();
	}

	const lambdaQuestions = await prompt([
		{
			name: "serviceName",
			message: "Service name. This can optionally be used in the path.",
			default: pkg.name,
		},
		{
			name: "path",
			message: "Path template for routes. ex: /{service}/{stage}/{version}",
			validate(template: string) {
				try {
					const path = simpleTemplate(template, {service: "service", version: "version", stage: "stage"});
					if (!path.startsWith("/")) {
						return "Must start with a '/'";
					}
					if (path.endsWith("/")) {
						return "Must not end with a '/'";
					}
					return true;
				} catch (e) {
					return "Invalid path template. Allowed Parms: service, stage, version";
				}
			},
			default: "/{service}/{stage}/{version}",
		},
		{
			name: "lambdaName",
			message: "Lambda function name",
			default: pkg.name,
		},
		{
			name: "bundleDir",
			message: "Directory containing lambda entrypoint.",
			validate(bundleDir: string) {
				try {
					if (statSync(dir).isDirectory()) {
						return true;
					} else {
						return "Must be a directory";
					}
				} catch (e) {
					return "File must exist";
				}
			},
			default: (pkg.main != null) ? dirname(pkg.main) : undefined,
		},
		{
			name: "entrypointModule",
			message: "File containing handler.",
			default: (pkg.main != null) ? parse(pkg.main).base : undefined,
			validate(file: string, options: any) {
				const path = join(options.bundleDir, file);
				if (!existsSync(path)) {
					return "File must exist";
				}
				if (extname(file) !== ".js") {
					return "Must be a js file";
				}
				return true;
			},
		},
		{
			name: "createFunction",
			message: "Create and upload now",
			default: true,
			type: "confirm",
		},
	]);

	const lambdaModule = parse(lambdaQuestions.entrypointModule).name;
	const lambdaRoleName = `${lambdaQuestions.lambdaName}-execution`;
	if (lambdaQuestions.createFunction) {
		console.log(`Creating role: ${lambdaRoleName}`);
		const lambdaRole = (await IAMClient.createRole({
			AssumeRolePolicyDocument: JSON.stringify(DefaultLambdaRoleAssume),
			RoleName: lambdaRoleName,
		}).promise()).Role;

		console.log("Updating policy");
		await IAMClient.putRolePolicy({
			PolicyDocument: JSON.stringify(DefaultLambdaPolicy),
			PolicyName: "CloudWatchAccess",
			RoleName: lambdaRoleName,
		}).promise();

		// console.log("Await Policy propagation");
		// await asyncTimeout(3000);

		console.log("Creating function");
		const bundleFunction = await zipDir(lambdaQuestions.bundleDir);
		const lambdaFunction = await promRetry((retry: any) => {
			return LambdaClient.createFunction({
				Runtime: "nodejs8.10",
				Role: lambdaRole.Arn,
				FunctionName: lambdaQuestions.lambdaName,
				Code: {
					ZipFile: bundleFunction,
				},
				Handler: `${lambdaModule}.handler`,
			} as any).promise().catch(retry);
		});
	}

	const config: ALBConfig = {
		loadBalancer: lbInfo.LoadBalancerName,
		pathTemplate: lambdaQuestions.path,
		region: LambdaClient.config.region,
		serviceName: lambdaQuestions.serviceName,
		lambda: {
			dir: lambdaQuestions.bundleDir,
			module: lambdaModule,
			name: lambdaQuestions.lambdaName,
			role: "",
		},
	};

	console.log("Saving config");
	setConfigProperty("alb", config, dir);
	console.log("Done");
}

export async function update(env: string, dir: string, pkg: IPackageJSON) {
	const config = getConfigProperty("alb", dir) as ALBConfig;
	if (config == null) {
		console.error("Missing alb configuration");
		return;
	}
	const LambdaClient = new Lambda();
	const ELBClient = new ELBv2();
	const path = simpleTemplate(config.pathTemplate, {
		service: config.serviceName,
		version: pkg.version,
		stage: env,
	});
	const safeName = `${pkg.version.replace(/\./g, "-")}-${env}-${config.serviceName}`;
	const safeNameSid = safeName.replace(/-/g, "_");
	console.log("Set configuration");
	await LambdaClient.updateFunctionConfiguration({
		FunctionName: config.lambda.name,
		// RevisionId: lambdaUpdate.RevisionId,
		Environment: {
			Variables: {
				PATH_PREFIX: path,
			},
		},
	}).promise();
	// first, update the lambda so that we guarantee the alias exists
	console.log("Update function");
	const lambdaUpdate = await LambdaClient.updateFunctionCode({
		FunctionName: config.lambda.name,
		Publish: true,
		ZipFile: await zipDir(config.lambda.dir),
	}).promise();

	console.log(`Version: ${lambdaUpdate.Version}`);

	try {
		await LambdaClient.updateAlias({
			FunctionName: config.lambda.name,
			FunctionVersion: lambdaUpdate.Version,
			Name: safeName,
		}).promise();
	} catch (e) {
		console.log("Create alias");
		await LambdaClient.createAlias({
			FunctionName: config.lambda.name,
			FunctionVersion: lambdaUpdate.Version,
			Name: safeName,
		}).promise();
	}

	let existingPermission;
	try {
		console.log("Checking current permissions");
		const currentPermissions = JSON.parse((await LambdaClient.getPolicy({
			FunctionName: config.lambda.name,
			Qualifier: safeName,
		}).promise()).Policy);
		currentPermissions.Statement.forEach((statement: any) => {
			if (statement.Sid === `${SID_PREFIX}_${safeNameSid}`) {
				existingPermission = statement;
			}
		});
	} catch (e) {
		// noop
	}

	if (existingPermission == null) {
		console.log("Creating target group");
		const targetGroup = (await ELBClient.createTargetGroup({
			TargetType: "lambda",
			Name: safeName,
		}).promise()).TargetGroups[0];

		console.log("Add permission");
		await LambdaClient.addPermission({
			SourceArn: targetGroup.TargetGroupArn,
			StatementId: `${SID_PREFIX}_${safeNameSid}`,
			FunctionName: config.lambda.name,
			Action: "lambda:InvokeFunction",
			Qualifier: safeName,
			Principal: "elasticloadbalancing.amazonaws.com",
		}).promise();

		const splitARN = lambdaUpdate.FunctionArn.split(":");
		splitARN[splitARN.length - 1] = safeName;
		console.log(`Register target: ${splitARN.join(":")}`);

		// console.log(targetGroup);
		await ELBClient.registerTargets({
			TargetGroupArn: targetGroup.TargetGroupArn,
			Targets: [
				{
					Id: splitARN.join(":"),
				},
			],
		}).promise();

		// retrieve the ARN
		console.log("Retrieve ALB ARN");
		const lbInfoArr = (await ELBClient.describeLoadBalancers({
			Names: [config.loadBalancer],
		}).promise());

		if (lbInfoArr.LoadBalancers.length !== 1) {
			console.error("Could not retrieve loadbalancer ARN");
			return;
		}

		// Get listeners
		console.log("Retrieve listener");
		const listenerInfo = (await ELBClient.describeListeners({
			LoadBalancerArn: lbInfoArr.LoadBalancers[0].LoadBalancerArn,
		}).promise()).Listeners;

		// Get current rules
		console.log("Retrieve rules");
		const ruleInfo = (await ELBClient.describeRules({
			ListenerArn: listenerInfo[0].ListenerArn,
		}).promise()).Rules;

		let currentPriority = 0;
		ruleInfo.forEach((rule) => {
			if (rule.Priority !== "default" && parseInt(rule.Priority, null) > currentPriority) {
				currentPriority = parseInt(rule.Priority, null);
			}
		});
		console.log(`Current priority is: ${currentPriority}`);
		// Create rule
		console.log("Create rule");
		await ELBClient.createRule({
			ListenerArn: listenerInfo[0].ListenerArn,
			Conditions: [
				{
					Field: "path-pattern",
					Values: [path + "*"],
				},
			],
			Actions: [
				{
					Type: "forward",
					TargetGroupArn: targetGroup.TargetGroupArn,
				},
			],
			Priority: currentPriority + 1,
		}).promise();
		console.log(`Accessible at: ${listenerInfo[0].Protocol.toLowerCase()}://${lbInfoArr.LoadBalancers[0].DNSName}${path}`);
	}
	console.log("Done");
}

export async function unregister(env: string, dir: string, pkg: IPackageJSON) {
	const config = getConfigProperty("alb", dir) as ALBConfig;
	if (config == null) {
		console.error("Missing alb configuration");
		return;
	}
	const LambdaClient = new Lambda();
	const ELBClient = new ELBv2();
	const path = simpleTemplate(config.pathTemplate, {
		service: config.serviceName,
		version: pkg.version,
		stage: env,
	});
	const safeName = `${pkg.version.replace(/\./g, "-")}-${env}-${config.serviceName}`;
	const safeNameSid = safeName.replace(/-/g, "_");
	console.log("Retrieve ALB ARN");
	const lbInfoArr = (await ELBClient.describeLoadBalancers({
		Names: [config.loadBalancer],
	}).promise());

	if (lbInfoArr.LoadBalancers.length !== 1) {
		console.error("Could not retrieve loadbalancer ARN");
		return;
	}

	// Get listeners
	console.log("Retrieve listener");
	const listenerInfo = (await ELBClient.describeListeners({
		LoadBalancerArn: lbInfoArr.LoadBalancers[0].LoadBalancerArn,
	}).promise()).Listeners;

	// Get current rules
	console.log("Retrieve rules");
	const ruleInfo = (await ELBClient.describeRules({
		ListenerArn: listenerInfo[0].ListenerArn,
	}).promise()).Rules;

	console.log("Retrieve Target Group ARN");
	const targetGroupInfo = (await ELBClient.describeTargetGroups({
		Names: [safeName],
	}).promise()).TargetGroups[0];

	let ruleInUse: ELBv2.Rule;
	ruleInfo.forEach((rule) => {
		rule.Actions.forEach((act) => {
			if (act.TargetGroupArn === targetGroupInfo.TargetGroupArn) {
				ruleInUse = rule;
			}
		});
	});

	console.log("Delete rule");
	await ELBClient.deleteRule({
		RuleArn: ruleInUse.RuleArn,
	}).promise();

	console.log("Delete target");
	await ELBClient.deleteTargetGroup({
		TargetGroupArn: targetGroupInfo.TargetGroupArn,
	}).promise();

	console.log("Delete lambda permissions");
	await LambdaClient.removePermission({
		StatementId: `${SID_PREFIX}_${safeNameSid}`,
		FunctionName: config.lambda.name,
		Qualifier: safeName,
	}).promise();

	console.log("Done");
}
