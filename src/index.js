import Boom from 'boom';
import Joi from 'joi';

import jwt from 'jsonwebtoken';
import Promise from 'bluebird';
import AWS from 'aws-sdk';
import uuid from 'node-uuid';

import { computeHash } from '@awsbb/hashing';
import Cache from '@awsbb/cache';

const boomError = ({ message, code = 500 }) => {
  const boomData = Boom.wrap(new Error(message), code).output.payload;
  return new Error(JSON.stringify(boomData));
};

// the redis cacheClient will connect and partition data in database 0
const cache = new Cache({
  endpoint: process.env.EC_ENDPOINT
});

const DynamoDB = new AWS.DynamoDB({
  region: process.env.REGION,
  endpoint: new AWS.Endpoint(process.env.DDB_ENDPOINT)
});

const getUserInfo = (email) => {
  return new Promise((resolve, reject) => {
    DynamoDB.getItem({
      TableName: 'awsBB_Users',
      Key: {
        email: {
          S: email
        }
      }
    }, (err, data) => {
      if (err) {
        return reject(err);
      }
      if (data.Item) {
        const hash = data.Item.passwordHash.S;
        const salt = data.Item.passwordSalt.S;
        const verified = data.Item.verified.BOOL;
        return resolve({
          salt,
          hash,
          verified
        });
      }
      reject(boomError({
        message: 'User Not Found',
        code: 404
      }));
    });
  });
};

const generateToken = ({ email, roles = [] }) => {
  const application = 'awsBB';
  const sessionID = uuid.v4();
  const token = jwt.sign({
    email,
    application,
    roles,
    sessionID
  }, process.env.JWT_SECRET, {
    expiresIn: '12 days'
  });
  return Promise.resolve({
    sessionID,
    token
  });
};

const joiEventSchema = Joi.object().keys({
  email: Joi.string().email(),
  password: Joi.string().min(6)
});

const joiOptions = {
  abortEarly: false
};

const validate = (event) => {
  return new Promise((resolve, reject) => {
    Joi.validate(event, joiEventSchema, joiOptions, (err) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  });
};

export function handler(event, context) {
  const email = event.payload.email;
  const password = event.payload.password;

  return cache.start()
    .then(() => validate(event.payload))
    .then(() => getUserInfo(email))
    .then(({ salt, hash, verified }) => {
      if (!verified) {
        return Promise.reject(boomError({
          message: 'User Not Verified',
          code: 401
        }));
      }
      const userHash = hash;
      return computeHash({ password, salt })
        .then(({ hash }) => {
          if (userHash !== hash) {
            return Promise.reject(boomError({
              message: 'Invalid Password',
              code: 401
            }));
          }
          return Promise.resolve();
        });
    })
    .then(() => generateToken({ email }))
    .then(({ sessionID, token }) => {
      return cache.set({ segment: 'logins', id: sessionID, value: token})
        .then(() => {
          return Promise.resolve({
            sessionID,
            token
          });
        });
    })
    .then(({ sessionID, token }) => {
      context.succeed({
        success: true,
        data: {
          sessionID,
          token
        }
      });
    })
    .catch((err) => {
      context.fail(err);
    })
    .finally(() => {
      return cache.stop();
    });
}
