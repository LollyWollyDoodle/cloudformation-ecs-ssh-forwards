const AWS = require("aws-sdk");

const cf = new AWS.CloudFormation({ apiVersion: "2010-05-15" });
const ecs = new AWS.ECS({ apiVersion: "2014-11-13" });
const ec2 = new AWS.EC2({ apiVersion: "2016-11-15" });

/**
 * Get the physical service name from the service stack name
 * and optional specific logical service name
 */
const getServiceName = function (serviceStackName, serviceName) {
	return new Promise(function (resolve, reject) {
		const params = { StackName: serviceStackName };
		if (serviceName) {
			params.LogicalResourceId = serviceName;
		}
		cf.describeStackResources(params, function (err, data) {
			if (err) reject(err); else resolve(data);
		});
	})
	.then(function (resources) {
		if (serviceName && resources.StackResources.length === 0) {
			throw new Error("Service not found");
		}
		else if (serviceName) {
			return resources.StackResources[0].PhysicalResourceId;
		}
		else {
			for (let i = 0; i < resources.StackResources.length; i++) {
				let resource = resources.StackResources[i];
				if (resource.ResourceType === "AWS::ECS::Service") {
					return resource.PhysicalResourceId;
				}
			}			
			throw new Error("Service not found");
		}
	});
};

/**
 * Get the ECS cluster stack name using the service stack name
 * and the conventional ClusterStackName service stack parameter
 * If service stack doesn't provide this, cluster stack name must be passed from CLI
 */
const getClusterStackName = function (serviceStackName) {
	return new Promise(function (resolve, reject) {
		cf.describeStacks({ StackName: serviceStackName }, function (err, data) {
			if (err) reject(err); else resolve(data);
		});
	})
	.then(function (data) {
		if (data.Stacks.length === 0) {
			throw new Error("Stack not found");
		}
		var clusterStackName;
		for (let i = 0; i < data.Stacks[0].Parameters.length; i++) {
			let param = data.Stacks[0].Parameters[i];
			if (param.ParameterKey === "ClusterStackName") {
				clusterStackName = param.ParameterValue;
				break;
			}
		}
		if (clusterStackName) {
			return clusterStackName;
		}
		else {
			throw new Error("Cluster stack parameter not found");
		}
	});
};

/**
 * Gets the physical cluster name from the cluster stack
 */
const getClusterName = function (clusterStackName) {
	return new Promise(function (resolve, reject) {
		cf.describeStackResources({
			StackName: clusterStackName,
			LogicalResourceId: "cluster"
		}, function (err, data) {
			if (err) reject(err); else resolve(data);
		});
	})
	.then(function (resources) {
		if (resources.StackResources.length === 0) {
			throw new Error("Cluster stack not found");
		}
		return resources.StackResources[0].PhysicalResourceId;
	});
};

/**
 * Main function
 */
module.exports = function (serviceStackName, serviceName, clusterStackName, containerPorts, ipv6, startingPort) {
	
	// Get physical cluster name from either cluster stack name
	// or conventional stack parameter of service stack
	const clusterName = clusterStackName && getClusterName(clusterStackName)
		|| getClusterStackName(serviceStackName).then(getClusterName);
	
	// List tasks for the service on the cluster (done to require fewer permissions)
	const taskList = Promise.all([
		getServiceName(serviceStackName, serviceName), 
		clusterName
	])
	.then(function (v) { const serviceName = v[0], clusterName = v[1];
		return new Promise(function (resolve, reject) {
			ecs.listTasks({
				serviceName: serviceName,
				cluster: clusterName
			}, function (err, data) {
				if (err) reject(err); else resolve(data);
			});
		});
	})
	.then(function (data) {
		return data.taskArns;
	});
	
	// Final structure of SSH commands to output
	const containerInstances = new Map();
	
	return Promise.all([clusterName, taskList])
	.then(function (v) { const clusterName = v[0], taskList = v[1];
	
		// Task details
		return new Promise(function (resolve, reject) {
			ecs.describeTasks({
				cluster: clusterName,
				tasks: taskList
			}, function (err, data) {
				if (err) reject(err); else resolve(data);
			});
		})
		.then(function (data) {
			
			// Service may be running multiple copies of the task
			for (let i = 0; i < data.tasks.length; i++) {
				let task = data.tasks[i];
				
				// Multiple containers in task
				for (let j = 0; j < task.containers.length; j++) {
					let container = task.containers[j];
					let containerName = task.overrides.containerOverrides[j].name;
					
					// If it has network bindings
					if (Array.isArray(container.networkBindings)) {
						for (let k = 0; k < container.networkBindings.length; k++) {
							let binding = container.networkBindings[k];
							
							// If we're limiting container ports to return
							if (containerPorts && containerPorts.has(binding.containerPort) || !containerPorts) {
								
								// Track by container name container instance it's running on
								let containerInstanceRequest = containerInstances.has(task.containerInstanceArn) && containerInstances.get(task.containerInstanceArn)
									|| { ports: new Map(), byHostPort: new Map() };
								containerInstanceRequest.ports.set(binding.containerPort, binding.hostPort);
								containerInstanceRequest.byHostPort.set(binding.hostPort, {
									containerName: containerName,
									containerPort: binding.containerPort
								});
								containerInstances.set(task.containerInstanceArn, containerInstanceRequest);
							}
						}
					}
				}
			}
			
			// Get information about the container instances stuff is running on
			return new Promise(function (resolve, reject) {
				ecs.describeContainerInstances({
					containerInstances: Array.from(containerInstances.keys()),
					cluster: clusterName
				}, function (err, data) {
					if (err) reject(err); else resolve(data);
				});
			});
		})
	})
	.then(function (data) {
		
		// Set EC2 instance ID on the data structure
		for (let i = 0; i < data.containerInstances.length; i++) {
			let containerInstance = data.containerInstances[i];
			containerInstances.get(containerInstance.containerInstanceArn).instanceId =
				containerInstance.ec2InstanceId;
		}
		
		// EC2 data to get public IPs
		return new Promise(function (resolve, reject) {
			ec2.describeInstances({
				InstanceIds: Array.from(containerInstances.values())
					.map(function (e, i, a) { return e.instanceId; })
			}, function (err, data) {
				if (err) reject(err); else resolve(data);
			});
		});
	})
	.then(function (data) {
		
		// Look for public IPs in the DescribeInstances data structure
		const instanceIps = new Map();
		for (let i = 0; i < data.Reservations.length; i++) {
			let r = data.Reservations[i];
			for (let j = 0; j < r.Instances.length; j++) {
				let instance = r.Instances[j];
				if (ipv6) {
					let addrs = instance.NetworkInterfaces[0].Ipv6Addresses;
					if (addrs && addrs[0]) {
						instanceIps.set(instance.InstanceId, addrs[0].Ipv6Address);
					}
					else {
						throw new Error("No IPv6 address");
					}
				}
				else {
					instanceIps.set(instance.InstanceId, instance.PublicIpAddress);
				}
			}
		}
		
		// Print out ports for each instance and what container ports they point to
		var port = startingPort || 49152;
		containerInstances.forEach(function (v, k, m) {
			v.ipAddress = instanceIps.get(v.instanceId);
			
			var str = "ssh";
			v.ports.forEach(function (v, k, m) {
				str += " -L" + port + ":localhost:" + v;
				port++;
			});
			str += " ec2-user@" + v.ipAddress;
			console.log(str);
			
			v.byHostPort.forEach(function (v, k, m) {
				console.log(k + "\t" + v.containerName + ":" + v.containerPort);
			});
		});
	});
}
