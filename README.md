# api-npm-scripts
> api managements utilities
## Basic info
All commands are intended to be run from the root directory of your api project (the one containing the package.json).
## Config Managements
Commands for managing app configuration.
### Commands
#### Update Config
Pushes a config for the given env using the current version.
```bash
# set the config for the dev env
api-npm-scripts config update -s dev
```
#### Get Config
Retrieves the configuration for a given environment using the current version.
```bash
# get the config for the given env
api-npm-scripts config get -s dev
```
#### List Configs
List available configs for all versions
```bash
api-npm-scripts config list
```
#### Delete Config
Delete a config for a given environment using the current version.
```bash
# delete the config for the dev env
api-npm-scripts config delete -s dev
```
## Api Management
Commands for managing the api
### Commands
#### Update Base Mappings
Updates base path mappings for a given environment using the current version and
claudia info from the config.

**Requirements**
* domain property in package.json set to api domain name
* claudia api configuration (either in claudia.json or config.json)

```bash
api-npm-scripts api update-base-mappings
```