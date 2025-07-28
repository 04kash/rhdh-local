'use strict';

var backendPluginApi = require('@backstage/backend-plugin-api');
var errors = require('@backstage/errors');
var alpha = require('@backstage/plugin-catalog-node/alpha');
var extensions = require('../extensions.cjs.js');
var KeycloakOrgEntityProvider = require('../providers/KeycloakOrgEntityProvider.cjs.js');
var pluginEventsNode = require('@backstage/plugin-events-node');
var catalogClient = require('@backstage/catalog-client');

const catalogModuleKeycloakEntityProvider = backendPluginApi.createBackendModule({
  pluginId: "catalog",
  moduleId: "catalog-backend-module-keycloak",
  register(env) {
    let userTransformer;
    let groupTransformer;
    env.registerExtensionPoint(extensions.keycloakTransformerExtensionPoint, {
      setUserTransformer(transformer) {
        if (userTransformer) {
          throw new errors.InputError("User transformer may only be set once");
        }
        userTransformer = transformer;
      },
      setGroupTransformer(transformer) {
        if (groupTransformer) {
          throw new errors.InputError("Group transformer may only be set once");
        }
        groupTransformer = transformer;
      }
    });
    env.registerInit({
      deps: {
        catalog: alpha.catalogProcessingExtensionPoint,
        config: backendPluginApi.coreServices.rootConfig,
        logger: backendPluginApi.coreServices.logger,
        discovery: backendPluginApi.coreServices.discovery,
        scheduler: backendPluginApi.coreServices.scheduler,
        auth: backendPluginApi.coreServices.auth,
        events: pluginEventsNode.eventsServiceRef
      },
      async init({ catalog, config, logger, discovery, scheduler, events, auth }) {
        const catalogApi = new catalogClient.CatalogClient({ discoveryApi: discovery });
        catalog.addEntityProvider(
          KeycloakOrgEntityProvider.KeycloakOrgEntityProvider.fromConfig(
            { config, logger, discovery, catalogApi, events, auth },
            {
              scheduler,
              schedule: scheduler.createScheduledTaskRunner({
                frequency: { hours: 24 },
                // One pull per day to catch any event updates that were missed
                timeout: { minutes: 3 }
              }),
              userTransformer,
              groupTransformer
            }
          )
        );
      }
    });
  }
});

exports.catalogModuleKeycloakEntityProvider = catalogModuleKeycloakEntityProvider;
//# sourceMappingURL=catalogModuleKeycloakEntityProvider.cjs.js.map
