'use strict';

var backendPluginApi = require('@backstage/backend-plugin-api');

const keycloakTransformerExtensionPoint = backendPluginApi.createExtensionPoint({
  id: "keycloak.transformer"
});

exports.keycloakTransformerExtensionPoint = keycloakTransformerExtensionPoint;
//# sourceMappingURL=extensions.cjs.js.map
