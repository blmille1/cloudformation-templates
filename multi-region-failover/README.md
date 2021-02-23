[Back to top-level README](../README.md)

# Introduction
- This template uses the 2019 version of Global DynamoDB Tables.  I had to do a lot of testing in various scenarios in order to get a system that works reliably.  That means that we drop an anchor (the first dynamodb table) in the OriginalPrimaryRegion and all new replicas get added from there.  Otherwise, there's an invisible dependency chain that depends on the order in which the replicas are made.  You don't have to worry about that--at least only a tiny bit, explained later.
- The basic rule is that when you add replicas, those tables must be deleted before you can remove the table from which the replica was added.  That's why I kept it simple and all replicas get added to the original primary region.
- You may deploy the stacks in any order and tear them down in any order, but there are caveats.
- When you tear down, it is the cleanest if you delete the stack in the original primary region last.  Otherwise, it'll leave that table hanging around.
- The config table name is the project name + `-config`.  If it finds a table with that name, it will assume that it's supposed to use it.
- For the sake of this example, we establish an environment variable `REGION_STATUS` for all lambdas.  If you're in the active region, then it is set to `active`.  Otherwise, it's `inactive`.  When you update the active region, all of the lambdas get updated to the new value.  If you want all regions to go inactive, set `active-region` in the dynamodb config table to something that's either nonsensical or a region in which you're not running.
- In this implementation, there is only ever one active region.  However, you can easily change that to operate in multiple regions.  I did it this way to limit the complexity of the example.

# Setup
- These instructions assume that you're in the same folder as this README file
- Install [cfn-lint](https://www.npmjs.com/package/cfn-lint)
- Install [cfn_nag_scan](https://github.com/stelligent/cfn_nag)

```bash
npm run install:full
cp samconfig-us-east-1.toml.sample samconfig-us-east-1.toml
cp samconfig-us-west-2.toml.sample samconfig-us-west-2.toml
```

- Update the `.toml` files with the appropriate values
- `export SAM_OPTS="--tags tag1:value1 tag2:value2` (set appropriate values, if necessary)

# Deploy
- Sign into AWS so you can deploy using SAM
- `npm run deploy:all` to deploy to `us-east-1` and then `us-east-2`.
- `npm run deploy:all:backwards` deploys the same stacks, but in the opposite order.
- Insert a key into the created dynamodb table with key `active-region` and a string value of `us-east-1`. (key=`active_region`, value=`us-east-1`).
- Look at the output from `processConfigChangeFuncLogGroup` and make sure all updated successfully in both regions

# Fail over
- Update the value to `us-west-2` and look at the log output again, validating that the lambdas are now configured to operate in `us-west-2`
- The whole flip-over should not take much longer than one second--usually about 700ms.

# Parameters
- `OriginalPrimaryRegion` - The original primary region that shall be declared as active.  This never changes.  When you want to fail over, you'll update the config dynamodb table.  This should be the same value for all `.toml` files
- `Tags` - This allows you to specify the tags that should be used when creating resources via the custom resource (in other words, for the dynamodb table)

# Outputs
- `ConfigTableArn` - Local DynamoDB Table ARN
- `ConfigTableStreamArn` - Local DynamoDB Table Stream ARN

# Misc.
- Please note that you can easily configure that function to do anything you need to do--like disable/enable alarms, schedules, etc...  I left those out in order to keep this template short.
- You can easily extend the global config to allow you to stop importing so that your database may slow down before deployments, etc. by modifying [lambdas/processConfigChange/app.js](lambdas/processConfigChange/app.js).
- Custom Resource (`cfnGlobalDynamodbManager`) Updates can only handle changes to Tags, but neither `TableName` nor `OriginalPrimaryRegion` may be modified once deployed.