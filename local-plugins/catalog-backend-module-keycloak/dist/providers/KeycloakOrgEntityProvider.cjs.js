'use strict';

var catalogModel = require('@backstage/catalog-model');
var errors = require('@backstage/errors');
var lodash = require('lodash');
var uuid = require('uuid');
var constants = require('../lib/constants.cjs.js');
var config = require('../lib/config.cjs.js');
var read = require('../lib/read.cjs.js');
var authenticate = require('../lib/authenticate.cjs.js');
var api = require('@opentelemetry/api');
var catalogClient = require('@backstage/catalog-client');
var transformers = require('../lib/transformers.cjs.js');

function _interopNamespaceCompat(e) {
  if (e && typeof e === 'object' && 'default' in e) return e;
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== 'default') {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () { return e[k]; }
        });
      }
    });
  }
  n.default = e;
  return Object.freeze(n);
}

var uuid__namespace = /*#__PURE__*/_interopNamespaceCompat(uuid);

const withLocations = (baseUrl, realm, entity) => {
  const kind = entity.kind === "Group" ? "groups" : "users";
  const location = `url:${baseUrl}/admin/realms/${realm}/${kind}/${entity.metadata.annotations?.[constants.KEYCLOAK_ID_ANNOTATION]}`;
  return lodash.merge(
    {
      metadata: {
        annotations: {
          [catalogModel.ANNOTATION_LOCATION]: location,
          [catalogModel.ANNOTATION_ORIGIN_LOCATION]: location
        }
      }
    },
    entity
  );
};
const TOPIC_USER_CREATE = "admin.USER-CREATE";
const TOPIC_USER_DELETE = "admin.USER-DELETE";
const TOPIC_USER_UPDATE = "admin.USER-UPDATE";
const TOPIC_USER_ADD_GROUP = "admin.GROUP_MEMBERSHIP-CREATE";
const TOPIC_USER_REMOVE_GROUP = "admin.GROUP_MEMBERSHIP-DELETE";
const TOPIC_GROUP_CREATE = "admin.GROUP-CREATE";
const TOPIC_GROUP_DELETE = "admin.GROUP-DELETE";
const TOPIC_GROUP_UPDATE = "admin.GROUP-UPDATE";
class KeycloakOrgEntityProvider {
  constructor(options) {
    this.options = options;
    this.meter = api.metrics.getMeter("default");
    this.counter = this.meter.createCounter(
      "backend_keycloak.fetch.task.failure.count",
      {
        description: "Counts the number of failed Keycloak data fetch tasks. Each increment indicates a complete failure of a fetch task, meaning no data was provided to the Catalog API. However, data may still be fetched in subsequent tasks, depending on the nature of the error."
      }
    );
    this.schedule(options.taskRunner);
    this.events = options.events;
    this.catalogApi = options.catalogApi ? options.catalogApi : new catalogClient.CatalogClient({ discoveryApi: options.discovery });
  }
  connection;
  meter;
  counter;
  scheduleFn;
  events;
  catalogApi;
  /**
   * Static builder method to create multiple KeycloakOrgEntityProvider instances from a single config.
   * @param deps - The dependencies required for the provider, including the configuration and logger.
   * @param options - Options for scheduling tasks and transforming users and groups.
   * @returns An array of KeycloakOrgEntityProvider instances.
   */
  static fromConfig(deps, options) {
    const { config: config$1, logger, catalogApi, events, auth, discovery } = deps;
    return config.readProviderConfigs(config$1).map((providerConfig) => {
      let taskRunner;
      if ("scheduler" in options && providerConfig.schedule) {
        taskRunner = options.scheduler.createScheduledTaskRunner(
          providerConfig.schedule
        );
      } else if ("schedule" in options) {
        taskRunner = options.schedule;
      } else {
        throw new errors.InputError(
          `No schedule provided via config for KeycloakOrgEntityProvider:${providerConfig.id}.`
        );
      }
      const provider = new KeycloakOrgEntityProvider({
        id: providerConfig.id,
        provider: providerConfig,
        logger,
        events,
        discovery,
        catalogApi,
        auth,
        taskRunner,
        userTransformer: options.userTransformer,
        groupTransformer: options.groupTransformer
      });
      return provider;
    });
  }
  /**
   * Returns the name of this entity provider.
   */
  getProviderName() {
    return `KeycloakOrgEntityProvider:${this.options.id}`;
  }
  /**
   * Connect to Backstage catalog entity provider
   * @param connection - The connection to the catalog API ingestor, which allows the provision of new entities.
   */
  async connect(connection) {
    this.connection = connection;
    await this.events?.subscribe({
      id: this.getProviderName(),
      topics: ["keycloak"],
      onEvent: async (params) => {
        const logger = this.options.logger;
        const provider = this.options.provider;
        logger.info(`Received event :${params.topic}`);
        const eventPayload = params.eventPayload;
        const KeyCloakAdminClientModule = await import('@keycloak/keycloak-admin-client');
        const KeyCloakAdminClient = KeyCloakAdminClientModule.default;
        const kcAdminClient = new KeyCloakAdminClient({
          baseUrl: provider.baseUrl,
          realmName: provider.loginRealm
        });
        await authenticate.authenticate(kcAdminClient, provider, logger);
        if (eventPayload.type === TOPIC_USER_CREATE || eventPayload.type === TOPIC_USER_DELETE || eventPayload.type === TOPIC_USER_UPDATE) {
          await this.onUserEvent({
            logger,
            eventPayload,
            client: kcAdminClient
          });
        }
        if (eventPayload.type === TOPIC_USER_ADD_GROUP || eventPayload.type === TOPIC_USER_REMOVE_GROUP) {
          await this.onMembershipChange({
            logger,
            eventPayload,
            client: kcAdminClient
          });
        }
        if (eventPayload.type === TOPIC_GROUP_CREATE || eventPayload.type === TOPIC_GROUP_UPDATE || eventPayload.type === TOPIC_GROUP_DELETE) {
          await this.onGroupEvent({
            logger,
            eventPayload,
            client: kcAdminClient
          });
        }
      }
    });
    await this.scheduleFn?.();
  }
  addEntitiesOperation = (entities) => ({
    removed: [],
    added: entities.map((entity) => ({
      locationKey: `keycloak-org-provider:${this.options.id}`,
      entity: withLocations(
        this.options.provider.baseUrl,
        this.options.provider.realm,
        entity
      )
    }))
  });
  removeEntitiesOperation = (entities) => ({
    added: [],
    removed: entities.map((entity) => ({
      locationKey: `keycloak-org-provider:${this.options.id}`,
      entity: withLocations(
        this.options.provider.baseUrl,
        this.options.provider.realm,
        entity
      )
    }))
  });
  async onUserEvent(options) {
    if (!this.connection) {
      throw new errors.NotFoundError("Not initialized");
    }
    const logger = options?.logger ?? this.options.logger;
    const provider = this.options.provider;
    const client = options.client;
    const userId = options.eventPayload.resourcePath.split("/")[1];
    if (options.eventPayload.type === TOPIC_USER_CREATE) {
      await this.handleUserCreate(userId, client, provider, logger);
    }
    if (options.eventPayload.type === TOPIC_USER_DELETE) {
      await this.handleUserDelete(userId, logger);
    }
    if (options.eventPayload.type === TOPIC_USER_UPDATE) {
      await this.onUserEdit(userId, client, provider, logger);
    }
    logger.info(
      `Processed Keycloak User Event: ${options.eventPayload.type} for user ID ${userId}`
    );
  }
  async handleUserCreate(userId, client, provider, logger) {
    await authenticate.ensureTokenValid(client, provider, logger);
    const userAdded = await client.users.findOne({ id: userId });
    if (!userAdded) {
      logger.debug(
        `Failed to fetch user with ID ${userId} after USER_CREATE event`
      );
      return;
    }
    const userEntity = await read.parseUser(
      userAdded,
      provider.realm,
      [],
      /* @__PURE__ */ new Map(),
      this.options.userTransformer
    );
    if (!userEntity) {
      logger.debug(`Failed to parse user entity for user ID ${userId}`);
      return;
    }
    const { added } = this.addEntitiesOperation([userEntity]);
    await this.connection.applyMutation({
      type: "delta",
      added,
      removed: []
    });
  }
  async handleUserDelete(userId, logger) {
    const { token } = await this.options.auth.getPluginRequestToken({
      onBehalfOf: await this.options.auth.getOwnServiceCredentials(),
      targetPluginId: "catalog"
    });
    const {
      items: [userEntity]
    } = await this.catalogApi.getEntities(
      {
        filter: {
          kind: "User",
          [`metadata.annotations.${constants.KEYCLOAK_ID_ANNOTATION}`]: userId
        }
      },
      { token }
    );
    if (!userEntity) {
      logger.debug(`Failed to parse user entity for user ID ${userId}`);
      return;
    }
    const { added, removed } = this.removeEntitiesOperation([
      userEntity
    ]);
    console.log(removed);
    await this.connection.applyMutation({
      type: "delta",
      added,
      removed
    });
  }
  async onUserEdit(userId, client, provider, logger) {
    const { token } = await this.options.auth.getPluginRequestToken({
      onBehalfOf: await this.options.auth.getOwnServiceCredentials(),
      targetPluginId: "catalog"
    });
    const {
      items: [oldUserEntity]
    } = await this.catalogApi.getEntities(
      {
        filter: {
          kind: "User",
          [`metadata.annotations.${constants.KEYCLOAK_ID_ANNOTATION}`]: userId
        }
      },
      { token }
    );
    const oldGroupEntityRefs = oldUserEntity?.relations?.filter((r) => r.type === "memberOf").map((r) => r.targetRef) ?? [];
    const oldGroupEntities = (await Promise.all(
      oldGroupEntityRefs.map(
        (ref) => this.catalogApi.getEntityByRef(ref, { token })
      )
    )).filter((entity) => !entity);
    const allGroups = (await Promise.all(
      oldGroupEntities.map(async (group) => {
        if (group.metadata.annotations) {
          await authenticate.ensureTokenValid(client, provider, logger);
          return await client.groups.findOne({
            id: group.metadata.annotations[constants.KEYCLOAK_ID_ANNOTATION],
            realm: provider.realm
          });
        }
        return undefined;
      })
    )).filter((g) => !g);
    const filteredParsedGroups = await this.createGroupEntities(
      allGroups,
      provider,
      client,
      logger
    );
    await authenticate.ensureTokenValid(client, provider, logger);
    const newUser = await client.users.findOne({ id: userId });
    if (!newUser) {
      logger.debug(
        `Failed to fetch user with ID ${userId} after USER_UPDATE event`
      );
      return;
    }
    const userToGroupMapping = /* @__PURE__ */ new Map();
    if (newUser.username) {
      userToGroupMapping.set(
        newUser.username,
        filteredParsedGroups.map((g) => g.entity.metadata.name)
      );
    }
    const newUserEntity = await read.parseUser(
      newUser,
      provider.realm,
      filteredParsedGroups,
      userToGroupMapping,
      this.options.userTransformer
    );
    if (!newUserEntity || !oldUserEntity) {
      logger.debug(`Failed to parse user entity for user ID ${userId}`);
      return;
    }
    const { added } = this.addEntitiesOperation([newUserEntity]);
    const { removed } = this.removeEntitiesOperation([oldUserEntity]);
    await this.connection.applyMutation({
      type: "delta",
      added,
      removed
    });
  }
  async onMembershipChange(options) {
    if (!this.connection) {
      throw new errors.NotFoundError("Not initialized");
    }
    const logger = options?.logger ?? this.options.logger;
    const provider = this.options.provider;
    const client = options.client;
    const userId = options.eventPayload.resourcePath.split("/")[1];
    const groupId = options.eventPayload.resourcePath.split("/")[3];
    const { token } = await this.options.auth.getPluginRequestToken({
      onBehalfOf: await this.options.auth.getOwnServiceCredentials(),
      targetPluginId: "catalog"
    });
    const {
      items: [oldUserEntity]
    } = await this.catalogApi.getEntities(
      {
        filter: {
          kind: "User",
          [`metadata.annotations.${constants.KEYCLOAK_ID_ANNOTATION}`]: userId
        }
      },
      { token }
    );
    await authenticate.ensureTokenValid(client, provider, logger);
    const newUser = await client.users.findOne({ id: userId });
    if (!newUser) {
      logger.debug(
        `Failed to fetch user with ID ${userId} after USER_UPDATE event`
      );
      return;
    }
    await authenticate.ensureTokenValid(client, provider, logger);
    const newGroup = await client.groups.findOne({
      id: groupId
    });
    newGroup.members = await read.getAllGroupMembers(
      async () => {
        await authenticate.ensureTokenValid(client, provider, logger);
        return client.groups;
      },
      groupId,
      provider,
      {
        userQuerySize: provider.userQuerySize
      }
    );
    let newGroupEntity = null;
    const parsedGroup = await read.parseGroup(
      newGroup,
      provider.realm,
      this.options.groupTransformer
    );
    if (parsedGroup) {
      newGroupEntity = {
        ...parsedGroup,
        entity: parsedGroup
      };
    }
    if (!newGroupEntity) {
      logger.debug(`Failed to parse group entity for group ID ${groupId}`);
      return;
    }
    const memberToGroupMap = /* @__PURE__ */ new Map();
    const currentGroupMemberships = oldUserEntity.spec?.memberOf ?? [];
    if (options.eventPayload.type === TOPIC_USER_ADD_GROUP) {
      currentGroupMemberships.push(newGroupEntity.entity.metadata.name);
    } else {
      const index = currentGroupMemberships.indexOf(
        newGroupEntity.entity.metadata.name
      );
      if (index > -1) {
        currentGroupMemberships.splice(index, 1);
      }
    }
    memberToGroupMap.set(oldUserEntity.metadata.name, currentGroupMemberships);
    const newUserEntity = await read.parseUser(
      newUser,
      provider.realm,
      [newGroupEntity],
      memberToGroupMap,
      this.options.userTransformer
    );
    if (!newUserEntity || !oldUserEntity) {
      logger.debug(
        `Failed to find user entity for user ID ${userId} after membership change event`
      );
      return;
    }
    if (!newGroupEntity) {
      logger.debug(
        `Failed to find group entity for group ID ${groupId} after membership change event`
      );
      return;
    }
    const { added } = this.addEntitiesOperation([
      newUserEntity
    ]);
    const { removed } = this.removeEntitiesOperation([
      oldUserEntity
    ]);
    await this.connection.applyMutation({
      type: "delta",
      added,
      removed
    });
    logger.info(
      `Processed Keycloak User Membership Change Event: ${options.eventPayload.type} for user ID ${userId} and group ID ${groupId}`
    );
  }
  async onGroupEvent(options) {
    if (!this.connection) {
      throw new errors.NotFoundError("Not initialized");
    }
    const logger = options?.logger ?? this.options.logger;
    const provider = this.options.provider;
    const client = options.client;
    const resourcePath = options.eventPayload.resourcePath.split("/");
    if (options.eventPayload.type === "admin.GROUP-CREATE") {
      await this.handleGroupCreate(
        resourcePath,
        options,
        logger,
        provider,
        client
      );
    }
    if (options.eventPayload.type === "admin.GROUP-DELETE") {
      await this.handleGroupDelete(resourcePath, logger, provider, client);
    }
  }
  async handleGroupCreate(resourcePath, options, logger, provider, client) {
    if (resourcePath.length === 2) {
      const groupId = resourcePath[1];
      await authenticate.ensureTokenValid(client, provider, logger);
      const group = await client.groups.findOne({ id: groupId });
      if (!group) {
        logger.debug(
          `Failed to fetch group with ID ${groupId} after GROUP_CREATE event`
        );
        return;
      }
      const groupEntity = await read.parseGroup(
        group,
        provider.realm,
        this.options.groupTransformer
      );
      if (!groupEntity) {
        logger.debug(`Failed to parse group entity for group ID ${groupId}`);
        return;
      }
      const { added } = this.addEntitiesOperation([groupEntity]);
      await this.connection.applyMutation({
        type: "delta",
        added,
        removed: []
      });
      logger.info(
        `Processed Keycloak Event ${options.eventPayload.type} for top-level group ID ${groupId}`
      );
    } else if (resourcePath.length === 3) {
      const parentGroupId = resourcePath[1];
      const subgroupId = JSON.parse(options.eventPayload.representation).id;
      await authenticate.ensureTokenValid(client, provider, logger);
      const newParentGroup = await client.groups.findOne({
        id: parentGroupId
      });
      if (!newParentGroup) {
        logger.debug(
          `Failed to fetch parent group with ID ${parentGroupId} after GROUP_CREATE event`
        );
        return;
      }
      await authenticate.ensureTokenValid(client, provider, logger);
      const subgroup = await client.groups.findOne({
        id: subgroupId
      });
      if (!subgroup) {
        logger.debug(
          `Failed to fetch subgroup with ID ${subgroupId} after GROUP_CREATE event`
        );
        return;
      }
      const { token } = await this.options.auth.getPluginRequestToken({
        onBehalfOf: await this.options.auth.getOwnServiceCredentials(),
        targetPluginId: "catalog"
      });
      const {
        items: [oldParentGroupEntity]
      } = await this.catalogApi.getEntities(
        {
          filter: {
            kind: "Group",
            [`metadata.annotations.${constants.KEYCLOAK_ID_ANNOTATION}`]: parentGroupId
          }
        },
        { token }
      );
      if (!oldParentGroupEntity) {
        logger.debug(
          `Failed to find old parent group entity for group ID ${parentGroupId} after GROUP_CREATE event`
        );
        return;
      }
      const filteredParsedGroups = await this.createGroupEntities(
        [subgroup, newParentGroup],
        provider,
        client,
        logger
      );
      if (filteredParsedGroups.length === 0) {
        logger.debug(
          `Failed to parse group entities for parent group ID ${parentGroupId} and subgroup ID ${subgroupId}`
        );
        return;
      }
      const { added } = this.addEntitiesOperation(
        filteredParsedGroups.map((g) => g.entity)
      );
      const { removed } = this.removeEntitiesOperation([oldParentGroupEntity]);
      await this.connection.applyMutation({
        type: "delta",
        added,
        removed
      });
      logger.info(
        `Processed Keycloak Event: ${options.eventPayload.type} for subgroup ID ${subgroupId} under parent group ID ${parentGroupId}`
      );
    }
  }
  async handleGroupDelete(resourcePath, logger, provider, client) {
    const groupId = resourcePath[1];
    const { token } = await this.options.auth.getPluginRequestToken({
      onBehalfOf: await this.options.auth.getOwnServiceCredentials(),
      targetPluginId: "catalog"
    });
    const {
      items: [deletedGroup]
    } = await this.catalogApi.getEntities(
      {
        filter: {
          kind: "Group",
          [`metadata.annotations.${constants.KEYCLOAK_ID_ANNOTATION}`]: groupId
        }
      },
      { token }
    );
    const parentEntityRef = this.getParentEntityRef(deletedGroup);
    const subgroupRefs = this.getSubgroupRefs(deletedGroup);
    const oldParentEntity = parentEntityRef ? await this.catalogApi.getEntityByRef(parentEntityRef, { token }) : undefined;
    const validSubgroupEntities = await this.getEntitiesByRefs(subgroupRefs);
    let newParent;
    if (oldParentEntity && oldParentEntity.metadata && oldParentEntity.metadata.annotations && oldParentEntity.metadata.annotations[constants.KEYCLOAK_ID_ANNOTATION]) {
      await authenticate.ensureTokenValid(client, provider, logger);
      newParent = await client.groups.findOne({
        id: oldParentEntity.metadata.annotations[constants.KEYCLOAK_ID_ANNOTATION]
      });
    }
    const [newParentEntity] = await this.createGroupEntities(
      [newParent].filter((g) => !!g),
      provider,
      client,
      logger
    );
    const userMembershipsToUpdate = this.collectUserMemberships(
      deletedGroup,
      validSubgroupEntities
    );
    const { oldUserEntities, newUserEntities } = await this.updateUserEntitiesAfterGroupDelete(
      userMembershipsToUpdate,
      provider,
      client,
      logger
    );
    const { added } = this.addEntitiesOperation([
      ...newParentEntity ? [newParentEntity.entity] : [],
      ...newUserEntities
    ]);
    const { removed } = this.removeEntitiesOperation([
      deletedGroup,
      ...oldParentEntity ? [oldParentEntity] : [],
      ...validSubgroupEntities,
      ...oldUserEntities
    ]);
    await this.connection.applyMutation({
      type: "delta",
      added,
      removed
    });
    logger.info(
      `Processed Keycloak group deletion event for group ID ${groupId} and its subgroups`
    );
  }
  getParentEntityRef(group) {
    return group.relations?.find((relation) => relation.type === "childOf")?.targetRef;
  }
  getSubgroupRefs(group) {
    return group.relations?.filter((relation) => relation.type === "parentOf").map((relation) => relation.targetRef) ?? [];
  }
  async getEntitiesByRefs(refs) {
    const { token } = await this.options.auth.getPluginRequestToken({
      onBehalfOf: await this.options.auth.getOwnServiceCredentials(),
      targetPluginId: "catalog"
    });
    const entities = await Promise.all(
      refs.map((ref) => this.catalogApi.getEntityByRef(ref, { token }))
    );
    return entities.filter((entity) => !!entity);
  }
  collectUserMemberships(deletedGroup, validSubgroupEntities) {
    const userMembershipsToUpdate = new Map(
      deletedGroup.relations?.filter((relation) => relation.type === "hasMember").map((relation) => [
        relation.targetRef,
        [
          `${deletedGroup.kind}:${deletedGroup.metadata.namespace}/${deletedGroup.metadata.name}`.toLowerCase()
        ]
      ]) ?? []
    );
    validSubgroupEntities.forEach((subgroup) => {
      const subgroupMemberships = subgroup.relations?.filter(
        (relation) => relation.type === "hasMember"
      );
      if (subgroupMemberships) {
        subgroupMemberships.forEach((relation) => {
          const currentMembers = userMembershipsToUpdate.get(relation.targetRef) ?? [];
          userMembershipsToUpdate.set(relation.targetRef, [
            ...currentMembers,
            `${subgroup.kind}:${subgroup.metadata.namespace}/${subgroup.metadata.name}`.toLowerCase()
          ]);
        });
      }
    });
    return userMembershipsToUpdate;
  }
  async updateUserEntitiesAfterGroupDelete(userMembershipsToUpdate, provider, client, logger) {
    const oldUserEntities = [];
    const newUserEntities = [];
    const { token } = await this.options.auth.getPluginRequestToken({
      onBehalfOf: await this.options.auth.getOwnServiceCredentials(),
      targetPluginId: "catalog"
    });
    for (const [userEntityRef] of userMembershipsToUpdate.entries()) {
      const userEntityInCatalog = await this.catalogApi.getEntityByRef(
        userEntityRef,
        { token }
      );
      if (userEntityInCatalog?.metadata.annotations?.[constants.KEYCLOAK_ID_ANNOTATION]) {
        oldUserEntities.push(userEntityInCatalog);
        await authenticate.ensureTokenValid(client, provider, logger);
        const userFromKeycloak = await client.users.findOne({
          id: userEntityInCatalog.metadata.annotations[constants.KEYCLOAK_ID_ANNOTATION]
        });
        if (userFromKeycloak) {
          const allGroups = await read.getAllGroups(
            () => Promise.resolve(client.users),
            userEntityInCatalog.metadata.annotations[constants.KEYCLOAK_ID_ANNOTATION],
            provider,
            {
              groupQuerySize: provider.groupQuerySize
            }
          );
          const filteredParsedGroups = await this.createGroupEntities(
            allGroups,
            provider,
            client,
            logger
          );
          const transformer = this.options.userTransformer ?? transformers.noopUserTransformer;
          const entity = {
            apiVersion: "backstage.io/v1beta1",
            kind: "User",
            metadata: {
              name: userFromKeycloak.username,
              annotations: {
                [constants.KEYCLOAK_ID_ANNOTATION]: userFromKeycloak.id,
                [constants.KEYCLOAK_REALM_ANNOTATION]: provider.realm
              }
            },
            spec: {
              profile: {
                email: userFromKeycloak.email,
                ...userFromKeycloak.firstName || userFromKeycloak.lastName ? {
                  displayName: [
                    userFromKeycloak.firstName,
                    userFromKeycloak.lastName
                  ].filter(Boolean).join(" ")
                } : {}
              },
              memberOf: allGroups.flatMap((g) => g?.name ? [g.name] : [])
            }
          };
          transformer(
            entity,
            userFromKeycloak,
            provider.realm,
            filteredParsedGroups
          );
          newUserEntities.push(entity);
        }
      }
    }
    return { oldUserEntities, newUserEntities };
  }
  async createGroupEntities(allGroups, provider, client, logger) {
    let rawKGroups = [];
    let serverVersion;
    try {
      serverVersion = await read.getServerVersion(client);
    } catch (error) {
      throw new Error(
        `Failed to retrieve Keycloak server information: ${error}`
      );
    }
    const isVersion23orHigher = serverVersion >= 23;
    if (isVersion23orHigher) {
      rawKGroups = await read.processGroupsRecursively(
        client,
        provider,
        logger,
        allGroups
      );
    } else {
      rawKGroups = allGroups.reduce(
        (acc, g) => acc.concat(...read.traverseGroups(g)),
        []
      );
    }
    const kGroups = await Promise.all(
      rawKGroups.map(async (g) => {
        g.members = await read.getAllGroupMembers(
          async () => {
            await authenticate.ensureTokenValid(client, provider, logger);
            return client.groups;
          },
          g.id,
          provider,
          {
            userQuerySize: provider.userQuerySize
          }
        );
        if (isVersion23orHigher) {
          if (g.subGroupCount > 0) {
            await authenticate.ensureTokenValid(client, provider, logger);
            g.subGroups = await client.groups.listSubGroups({
              parentId: g.id,
              first: 0,
              max: g.subGroupCount,
              briefRepresentation: this.options.provider.briefRepresentation ?? constants.KEYCLOAK_BRIEF_REPRESENTATION_DEFAULT,
              realm: provider.realm
            });
          }
          if (g.parentId) {
            await authenticate.ensureTokenValid(client, provider, logger);
            const groupParent = await client.groups.findOne({
              id: g.parentId,
              realm: provider.realm
            });
            g.parent = groupParent?.name;
          }
        }
        return g;
      })
    );
    const parsedGroups = await Promise.all(
      kGroups.map(async (g) => {
        if (!g) return null;
        const entity = await read.parseGroup(
          g,
          provider.realm,
          this.options.groupTransformer
        );
        if (entity) {
          return {
            ...g,
            entity
          };
        }
        return null;
      })
    );
    return parsedGroups.filter(
      (group) => group !== null
    );
  }
  /**
   * Runs one complete ingestion loop. Call this method regularly at some
   * appropriate cadence.
   */
  async read(options) {
    if (!this.connection) {
      throw new errors.NotFoundError("Not initialized");
    }
    const logger = options?.logger ?? this.options.logger;
    const provider = this.options.provider;
    const { markReadComplete } = trackProgress(logger);
    const KeyCloakAdminClientModule = await import('@keycloak/keycloak-admin-client');
    const KeyCloakAdminClient = KeyCloakAdminClientModule.default;
    const kcAdminClient = new KeyCloakAdminClient({
      baseUrl: provider.baseUrl,
      realmName: provider.loginRealm
    });
    await authenticate.authenticate(kcAdminClient, provider, logger);
    const pLimitCJSModule = await import('p-limit');
    const limitFunc = pLimitCJSModule.default;
    const concurrency = provider.maxConcurrency ?? 20;
    const limit = limitFunc(concurrency);
    const dataBatchFailureCounter = this.meter.createCounter(
      "backend_keycloak.fetch.data.batch.failure.count",
      {
        description: "Keycloak data batch fetch failure counter. Incremented for each batch fetch failure. Each failure means that a part of the data was not fetched due to an error, and thus the corresponding data batch was skipped during the current fetch task."
      }
    );
    const { users, groups } = await read.readKeycloakRealm(
      kcAdminClient,
      provider,
      logger,
      limit,
      options.taskInstanceId,
      dataBatchFailureCounter,
      {
        userQuerySize: provider.userQuerySize,
        groupQuerySize: provider.groupQuerySize,
        userTransformer: this.options.userTransformer,
        groupTransformer: this.options.groupTransformer
      }
    );
    const { markCommitComplete } = markReadComplete({ users, groups });
    await this.connection.applyMutation({
      type: "full",
      entities: [...users, ...groups].map((entity) => ({
        locationKey: `keycloak-org-provider:${this.options.id}`,
        entity: withLocations(provider.baseUrl, provider.realm, entity)
      }))
    });
    markCommitComplete();
  }
  /**
   * Periodically schedules a task to read Keycloak user and group information, parse it, and provision it to the Backstage catalog.
   * @param taskRunner - The task runner to use for scheduling tasks.
   */
  schedule(taskRunner) {
    this.scheduleFn = async () => {
      const id = `${this.getProviderName()}:refresh`;
      await taskRunner.run({
        id,
        fn: async () => {
          const taskInstanceId = uuid__namespace.v4();
          const logger = this.options.logger.child({
            class: KeycloakOrgEntityProvider.prototype.constructor.name,
            taskId: id,
            taskInstanceId
          });
          try {
            await this.read({ logger, taskInstanceId });
          } catch (error) {
            this.counter.add(1, { taskInstanceId });
            if (errors.isError(error)) {
              logger.error("Error while syncing Keycloak users and groups", {
                // Default Error properties:
                name: error.name,
                cause: error.cause,
                message: error.message,
                stack: error.stack,
                // Additional status code if available:
                status: error.response?.status
              });
            }
          }
        }
      });
    };
  }
}
function trackProgress(logger) {
  let timestamp = Date.now();
  let summary;
  logger.info("Reading Keycloak users and groups");
  function markReadComplete(read) {
    summary = `${read.users.length} Keycloak users and ${read.groups.length} Keycloak groups`;
    const readDuration = ((Date.now() - timestamp) / 1e3).toFixed(1);
    timestamp = Date.now();
    logger.info(`Read ${summary} in ${readDuration} seconds. Committing...`);
    return { markCommitComplete };
  }
  function markCommitComplete() {
    const commitDuration = ((Date.now() - timestamp) / 1e3).toFixed(1);
    logger.info(`Committed ${summary} in ${commitDuration} seconds.`);
  }
  return { markReadComplete };
}

exports.KeycloakOrgEntityProvider = KeycloakOrgEntityProvider;
exports.withLocations = withLocations;
//# sourceMappingURL=KeycloakOrgEntityProvider.cjs.js.map
