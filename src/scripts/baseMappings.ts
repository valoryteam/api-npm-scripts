import {IPackageJSON} from "../lib/package";
import {APIGateway} from "aws-sdk";
import {getConfigProperty} from "../lib/util";

export async function updateBaseMappings(env: string, dir: string, pkgJson: IPackageJSON) {
	const APIGW = new APIGateway();
	const config = {
		api: getConfigProperty("api", dir),
		lambda: getConfigProperty("lambda", dir),
	};

	if (config.lambda == null || config.api == null) {
		console.error("Claudia configuration missing from config");
		return;
	}

	if (pkgJson.domain == null) {
		console.error("Domain specification missing from package.json");
		return;
	}

	const stageName = `${pkgJson.version}-${env}`;
	const lambdaVersion = stageName.replace(/[\.-]/g, "_");

	const getRequest: APIGateway.GetBasePathMappingRequest = {
		domainName: pkgJson.domain,
		basePath: stageName,
	};

	await APIGW.getBasePathMapping(getRequest).promise().then(async (data) => {
		console.log("Found existing mapping; updating");
		const updateRequest: APIGateway.UpdateBasePathMappingRequest = {
			basePath: stageName,
			domainName: pkgJson.domain,
			patchOperations: [
				{
					op: "replace",
					path: "/stage",
					value: lambdaVersion,
				},
			],
		};

		try {
			await APIGW.updateBasePathMapping(updateRequest).promise();
			console.log("Updated current mapping");
			console.log("Done");
		} catch (err) {
			console.error("Could not update current mapping");
			console.error(err);
			return;
		}
	}, async (err) => {
		if (err.statusCode === 404) {
			const createRequest: APIGateway.CreateBasePathMappingRequest = {
				domainName: pkgJson.domain,
				restApiId: config.api.id,
				basePath: stageName,
				stage: lambdaVersion,
			};

			try {
				await APIGW.createBasePathMapping(createRequest).promise();
				console.log("Created new mapping");
				console.log("Done");
			} catch (err) {
				console.error("Failed to create mapping");
				console.error(err);
				return;
			}
		} else {
			console.error("Received weird error trying to get current mapping, proceeding with hamster murder");
			console.error(err);
			return;
		}
	});
}