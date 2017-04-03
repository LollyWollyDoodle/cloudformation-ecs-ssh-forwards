#!/usr/bin/env node

const process = require("process");

const cmd = require("commander");

const f = require("./index");

cmd
	.usage("[options] stack-name")
	.option("-p, --container-ports [values]", "Limit container ports", function (val) {
		const s = new Set();
		const vs = val.split(",");
		for (let i = 0; i < vs.length; i++) {
			s.add(Number(vs[i]));
		}
		return s;
	})
	.option("-s, --service-name [value]", "The service to get containers for")
	.option("-c, --cluster-stack-name [value]", "Which cluster stack to get container instances for")
	.option("-6, --ipv6", "Attempt to get IPv6 addresses for the container instances")
	.parse(process.argv);

f(cmd.args[0], cmd.serviceName, cmd.clusterStackName, cmd.containerPorts, cmd.ipv6)
.then(null, function (err) { console.error(err); });
