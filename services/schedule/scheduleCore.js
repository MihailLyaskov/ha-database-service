// @flow weak
const config = require('config');
const mongodb = require("mongodb").MongoClient;
const scheduler = require('node-schedule');
var _jobs = []
var _seneca = null
var _collection = null;



var schedule = function(seneca) {
  _seneca = seneca;
}

schedule.prototype.init = async function(callback) {
  try {
    let mongo = await mongodb.connect('mongodb://' + config.device_config.mongoSchedule.host + ':' + config.device_config.mongoSchedule.port + '/' + config.device_config.mongoSchedule.database);
    _collection = await mongo.collection(config.device_config.mongoSchedule.collection);
    let reCreate = await reCreateSchedules();
    callback(null, _collection);
  } catch (err) {
    callback(err)
  }
}
/**
 * @api {get} schedule/create Create a daily schedule for a device
 * @apiVersion 1.0.0
 * @apiName create
 * @apiGroup Schedule
 *
 * @apiParam {String} DeviceID Unique device name.
 * @apiParam {Array} schedule An array containing objects with begin and end hour for an event.
 * @apiParam {String} beginTime Begin time - example: "13:00:00"
 * @apiParam {String} endTime End time - example "14:00:00"
 * @apiParam {Float} maxEnergy Maximum energy that should not be passed.
 *
 * @apiExample  Example usage:
 *{
 *    "DeviceID": "TestDevice",
 *    "schedule": [{
 *        "beginTime": "17:00:00",
 *        "endTime": "18:00:00"
 *    }],
 *    "maxEnergy": 1500.0,
 *    "notification": "device/int"
 *}
 */
schedule.prototype.create = async function(args, done) {
  if (validateSchedule(args)) {
    //Create the jobs that will be working on the new schedule
    let len = args.schedule.length;
    let jobs = [];
    let name = args.DeviceID;
    let check = null
    try {
      check = await _collection.findOne({
        Device: name
      })
      console.log(check)
      if (check != null) {
        done(null, {
          result: name + ' already has a schedule! Remove it first!',
          status: "ERROR"
        })
      }
    } catch (err) {
      console.log(err)
    }
    if (check == null) {
      for (let i = 0; i < len; i++) {
        let beginJob = createJob(args.DeviceID, args.schedule[i].beginTime, "On")
        jobs.push(beginJob)
        let endJob = createJob(args.DeviceID, args.schedule[i].endTime, "Off")
        jobs.push(endJob)
      }
      // This job resets agregated energy for this schedule in 00:00:00 every day
      let resetJob = resetAgrEnergyJob(args.DeviceID)
      jobs.push(resetJob)
      //Add schedule jobs objects to _jobs array for use later
      _jobs.push({
        device: args.DeviceID,
        jobs: jobs
      });
      //Save the new schedule to database
      try {
        let saveToMongo = await storeInDatabase(args)
        let subscibe = await makeSubscription(args.DeviceID, args.notification)
        //console.log(saveToMongo)
      } catch (err) {
        console.error(err)
      }
      done(null, {
        result: "Created daily schedule for " + args.DeviceID,
        status: "OK"
      })
    }
  } else {
    done(null, {
      result: 'Missing or wrong argumets!',
      status: "ERROR"
    })
  }
}



/**
 * @api {get} schedule/remove Remove a daily schedule for a device
 * @apiVersion 1.0.0
 * @apiName remove
 * @apiGroup Schedule
 *
 * @apiParam {String} DeviceID Unique device name.
 *
 * @apiExample  Example usage:
 *{
 *    "DeviceID": "TestDevice",
 *}
 */
schedule.prototype.remove = async function(args, done) {
  if (args.hasOwnProperty('DeviceID') == true) {
    let result = {};
    let removeSub;
    // Remove schedule from database and get schedule index
    try {
      result = await removeFromDatabase(args.DeviceID)
      if (result.status == 'found') {
        removeSub = await removeSubscription(args.DeviceID, result.notification)
        //Cancel jobs working on the removed schedule
        // find schedule
        for (let i = 0; i < _jobs.length; i++) {
          if (_jobs[i].device == args.DeviceID) {
            let len = _jobs[i].jobs.length;
            for (let j = 0; j < len; j++) {
              let cancel = await _jobs[i].jobs[j].cancel();
            }
            //Remove jobs from _jobs array
            _jobs.splice(result.index, 1);
            //Send result message
            done(null, {
              result: "Schedule for " + args.DeviceID + " is removed!",
              status: "OK"
            })
          }
        }

      } else {
        done(null, {
          result: result.message,
          status: "ERROR"
        })
      }
    } catch (err) {
      console.error(err)
    }
  } else {
    done(null, {
      result: 'Missing argumets!',
      status: "ERROR"
    })
  }
}

/**
 * @api {get} schedule/showAll Remove a daily schedule for a device
 * @apiVersion 1.0.0
 * @apiName showAll
 * @apiGroup Schedule
 *
 * @apiExample  Example usage:
 *{}
 */
schedule.prototype.showAll = async function(args, done) {
  try {
    let result = await _collection.find().toArray()
    done(null, {
      result: result,
      status: "OK"
    })
  } catch (err) {
    console.error(err)
    done(null, {
      result: "Error",
      status: "ERROR"
    })
  }
}

/**
 * @api {get} schedule/showSubs Show currently active subscriptions.
 * @apiVersion 1.0.0
 * @apiName showSubs
 * @apiGroup Schedule
 *
 */
schedule.prototype.showSubs = function(args, done) {
  _seneca.act({
    role: 'client',
    cmd: 'showSubs'
  }, function(err, res) {
    if (res.status == 'Error') {
      //console.error(err)
      done(null, {
        result: err,
        status: 'Error'
      })
    } else {
      done(null, {
        result: res.data,
        status: 'OK'
      })
    }
  })
}

schedule.prototype.evaluate = async function(args, done) {
  console.log("SCHEDULE EVALUATE:")
  try {
    let find = await _collection.findOne({
      Device: args.device
    })
    let energy = find.agrEnergy
    if (find.maxEnergy < (energy + args.energy)) {
      let stopDevice = await _seneca.act({
        role: "client",
        cmd: "sendCommand",
        DeviceID: args.device,
        command: "state",
        params: {
          state: "OFF"
        }
      });
    } else {
      let update = await _collection.updateOne({
        Device: args.device
      }, {
        $set: {
          agrEnergy: energy + args.energy
        }
      });
    }
    done(null, {
      status: "OK"
    })
  } catch (err) {
    done(null, {
      status: "ERROR"
    })
    console.log(err)
  }
}

function resetAgrEnergyJob(device) {
  let rule = new scheduler.RecurrenceRule();
  rule.hour = '00';
  rule.minute = '00';
  rule.second = '00';
  return scheduler.scheduleJob(rule, async function() {
    try {
      let update = await _collection.updateOne({
        Device: device
      }, {
        $set: {
          agrEnergy: 0.0
        }
      });
    } catch (err) {
      console.log(err)
    }
  });
}

function reCreateSchedules() {
  return new Promise(async function(resolve, reject) {
    try {
      let result = await _collection.find().toArray()
      let len = result.length
      if (len > 0) {
        for (let i = 0; i < len; i++) {
          let jobs = [];
          let scheduleCount = result[i].schedule.length;
          for (let j = 0; j < scheduleCount; j++) {
            let beginJob = createJob(result[i].Device, result[i].schedule[j].beginTime, "On")
            jobs.push(beginJob)
            let endJob = createJob(result[i].Device, result[i].schedule[j].endTime, "Off")
            jobs.push(endJob)
          }
          _jobs.push({
            jobs: jobs
          })
        }
        resolve()
        console.log(_jobs)
      }
    } catch (err) {
      reject(err)
    }
  })
}

function validateSchedule(args) {
  if (args.hasOwnProperty('DeviceID') && args.hasOwnProperty('schedule') && args.hasOwnProperty('maxEnergy') &&
    args.hasOwnProperty('notification')) {
    if (Array.isArray(args.schedule) && typeof args.DeviceID === 'string' && typeof args.notification === 'string') {
      return true
    } else {
      return false
    }
  } else {
    return false
  }
}

function removeSubscription(device, notif) {
  return new Promise(function(resolve, reject) {
    _seneca.act({
      role: 'client',
      cmd: 'unsubscribe'
    }, {
      params: {
        DeviceID: device,
        notification: notif,
        service: 'schedule'
      }
    }, function(err, res) {
      if (res.status == 'Error') {
        console.error(err)
        reject(err)
      } else {
        resolve(`Started logging data for ${device}!`)
      }
    })
  })
}

function makeSubscription(device, notification) {
  return new Promise(function(resolve, reject) {
    _seneca.act({
      role: 'client',
      cmd: 'subscribe'
    }, {
      params: {
        DeviceID: device,
        notification: notification,
        service: 'schedule'
      }
    }, function(err, res) {
      if (res.status == 'Error') {
        console.error(err)
        reject(err)
      } else {
        resolve(`Started logging data for ${device}!`)
      }
    })
  })
}

function storeInDatabase(args) {
  return new Promise(async function(resolve, reject) {
    try {
      let insert = await _collection.insertOne({
        Device: args.DeviceID,
        schedule: args.schedule,
        maxEnergy: args.maxEnergy,
        notification: args.notification,
        agrEnergy: 0.0
      })
      resolve(insert)
    } catch (err) {
      reject(err)
    }
  })
}

function removeFromDatabase(DeviceID) {
  return new Promise(async function(resolve, reject) {
    try {
      let remove = await _collection.findOneAndDelete({
        Device: DeviceID
      })
      if (remove.value == null) {
        resolve({
          status: 'not found',
          message: 'No schedule found for ' + DeviceID
        })
      } else {
        resolve({
          status: 'found',
          notification: remove.value.notification
        })
      }
    } catch (err) {
      reject(err)
    }
  })
}

function createJob(device, time, state) {
  console.log(time)
  let timeArr = parceTimeData(time)
  let rule = new scheduler.RecurrenceRule();
  rule.hour = timeArr.hour;
  rule.minute = timeArr.minute;
  rule.second = timeArr.second;
  return scheduler.scheduleJob(rule, function() {
    console.log(time);
    _seneca.act({
      role: "client",
      cmd: "sendCommand"
    }, {
      DeviceID: device,
      command: "state",
      params: {
        state: state
      }
    }, function(err, res) {
      if (err)
        console.log(err)
    });
  });
}

function parceTimeData(time) {
  if (typeof time === 'string') {
    let result = time.split(":");
    return {
      hour: result[0],
      minute: result[1],
      second: result[2]
    }
  }
}



module.exports = schedule;
