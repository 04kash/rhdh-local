'use strict';

var backendPluginApi = require('@backstage/backend-plugin-api');
var errors = require('@backstage/errors');

const readProviderConfig = (id, providerConfigInstance) => {
  const baseUrl = providerConfigInstance.getString("baseUrl");
  const realm = providerConfigInstance.getOptionalString("realm") ?? "master";
  const loginRealm = providerConfigInstance.getOptionalString("loginRealm") ?? "master";
  const username = providerConfigInstance.getOptionalString("username");
  const password = providerConfigInstance.getOptionalString("password");
  const clientId = providerConfigInstance.getOptionalString("clientId");
  const clientSecret = providerConfigInstance.getOptionalString("clientSecret");
  const userQuerySize = providerConfigInstance.getOptionalNumber("userQuerySize");
  const groupQuerySize = providerConfigInstance.getOptionalNumber("groupQuerySize");
  const maxConcurrency = providerConfigInstance.getOptionalNumber("maxConcurrency");
  const briefRepresentation = providerConfigInstance.getOptionalBoolean(
    "briefRepresentation"
  );
  if (clientId && !clientSecret) {
    throw new errors.InputError(
      `clientSecret must be provided when clientId is defined.`
    );
  }
  if (clientSecret && !clientId) {
    throw new errors.InputError(
      `clientId must be provided when clientSecret is defined.`
    );
  }
  if (username && !password) {
    throw new errors.InputError(`password must be provided when username is defined.`);
  }
  if (password && !username) {
    throw new errors.InputError(`username must be provided when password is defined.`);
  }
  const schedule = providerConfigInstance.has("schedule") ? backendPluginApi.readSchedulerServiceTaskScheduleDefinitionFromConfig(
    providerConfigInstance.getConfig("schedule")
  ) : undefined;
  return {
    id,
    baseUrl,
    loginRealm,
    realm,
    username,
    password,
    clientId,
    clientSecret,
    schedule,
    userQuerySize,
    groupQuerySize,
    maxConcurrency,
    briefRepresentation
  };
};
const readProviderConfigs = (config) => {
  const providersConfig = config.getOptionalConfig(
    "catalog.providers.keycloakOrg"
  );
  if (!providersConfig) {
    return [];
  }
  return providersConfig.keys().map((id) => {
    const providerConfigInstance = providersConfig.getConfig(id);
    return readProviderConfig(id, providerConfigInstance);
  });
};

exports.readProviderConfigs = readProviderConfigs;
//# sourceMappingURL=config.cjs.js.map
