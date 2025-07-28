'use strict';

var errors = require('@backstage/errors');
var jwt = require('jsonwebtoken');

function _interopDefaultCompat (e) { return e && typeof e === 'object' && 'default' in e ? e : { default: e }; }

var jwt__default = /*#__PURE__*/_interopDefaultCompat(jwt);

let refreshTokenPromise = null;
async function ensureTokenValid(kcAdminClient, provider, logger) {
  if (!kcAdminClient.accessToken) {
    await authenticate(kcAdminClient, provider, logger);
  } else {
    const decodedToken = jwt__default.default.decode(kcAdminClient.accessToken);
    if (decodedToken && typeof decodedToken === "object" && decodedToken.exp) {
      const tokenExpiry = decodedToken.exp * 1e3;
      const now = Date.now();
      if (now > tokenExpiry - 3e4) {
        refreshTokenPromise = authenticate(
          kcAdminClient,
          provider,
          logger
        ).finally(() => {
          refreshTokenPromise = null;
        });
      }
      await refreshTokenPromise;
    }
  }
}
async function authenticate(kcAdminClient, provider, logger) {
  try {
    let credentials;
    if (provider.username && provider.password) {
      credentials = {
        grantType: "password",
        clientId: provider.clientId ?? "admin-cli",
        username: provider.username,
        password: provider.password
      };
    } else if (provider.clientId && provider.clientSecret) {
      credentials = {
        grantType: "client_credentials",
        clientId: provider.clientId,
        clientSecret: provider.clientSecret
      };
    } else {
      throw new errors.InputError(
        `username and password or clientId and clientSecret must be provided.`
      );
    }
    await kcAdminClient.auth(credentials);
  } catch (error) {
    logger.error("Failed to authenticate", error.message);
    throw error;
  }
}

exports.authenticate = authenticate;
exports.ensureTokenValid = ensureTokenValid;
//# sourceMappingURL=authenticate.cjs.js.map
