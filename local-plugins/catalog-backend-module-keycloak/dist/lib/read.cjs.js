'use strict';

var constants = require('./constants.cjs.js');
var transformers = require('./transformers.cjs.js');
var authenticate = require('./authenticate.cjs.js');

const parseGroup = async (keycloakGroup, realm, groupTransformer) => {
  const transformer = groupTransformer ?? transformers.noopGroupTransformer;
  const entity = {
    apiVersion: "backstage.io/v1beta1",
    kind: "Group",
    metadata: {
      name: keycloakGroup.name,
      annotations: {
        [constants.KEYCLOAK_ID_ANNOTATION]: keycloakGroup.id,
        [constants.KEYCLOAK_REALM_ANNOTATION]: realm
      }
    },
    spec: {
      type: "group",
      profile: {
        displayName: keycloakGroup.name
      },
      // children, parent and members are updated again after all group and user transformers applied.
      children: keycloakGroup.subGroups?.map((g) => g.name) ?? [],
      parent: keycloakGroup.parent,
      members: keycloakGroup.members
    }
  };
  return await transformer(entity, keycloakGroup, realm);
};
const parseUser = async (user, realm, keycloakGroups, groupIndex, userTransformer) => {
  const transformer = userTransformer ?? transformers.noopUserTransformer;
  const entity = {
    apiVersion: "backstage.io/v1beta1",
    kind: "User",
    metadata: {
      name: user.username,
      annotations: {
        [constants.KEYCLOAK_ID_ANNOTATION]: user.id,
        [constants.KEYCLOAK_REALM_ANNOTATION]: realm
      }
    },
    spec: {
      profile: {
        email: user.email,
        ...user.firstName || user.lastName ? {
          displayName: [user.firstName, user.lastName].filter(Boolean).join(" ")
        } : {}
      },
      memberOf: groupIndex.get(user.username) ?? []
    }
  };
  return await transformer(entity, user, realm, keycloakGroups);
};
async function getEntities(getEntitiesFn, config, logger, dataBatchFailureCounter, taskInstanceId, limit, entityQuerySize = constants.KEYCLOAK_ENTITY_QUERY_SIZE) {
  const entitiesAPI = await getEntitiesFn();
  const rawEntityCount = await entitiesAPI.count({ realm: config.realm });
  const entityCount = typeof rawEntityCount === "number" ? rawEntityCount : rawEntityCount.count;
  const pageCount = Math.ceil(entityCount / entityQuerySize);
  const brief = config.briefRepresentation ?? constants.KEYCLOAK_BRIEF_REPRESENTATION_DEFAULT;
  const entityPromises = Array.from(
    { length: pageCount },
    (_, i) => limit(
      () => getEntitiesFn().then((entities) => {
        return entities.find({
          realm: config.realm,
          max: entityQuerySize,
          first: i * entityQuerySize,
          briefRepresentation: brief
        }).then((ents) => {
          logger.debug(
            `Importing keycloak entities batch with index ${i} from pages: ${pageCount}`
          );
          return ents;
        }).catch((err) => {
          dataBatchFailureCounter.add(1, { taskInstanceId });
          logger.warn(
            `Failed to retieve Keycloak entities for taskInstanceId: ${taskInstanceId}. Error: ${err}`
          );
          return [];
        });
      })
    )
  );
  const entityResults = (await Promise.all(entityPromises)).flat();
  return entityResults;
}
async function getAllGroupMembers(groupsAPI, groupId, config, options) {
  const querySize = options?.userQuerySize || 100;
  let allMembers = [];
  let page = 0;
  let totalMembers = 0;
  do {
    const groups = await groupsAPI();
    const members = await groups.listMembers({
      id: groupId,
      max: querySize,
      realm: config.realm,
      first: page * querySize
    });
    if (members.length > 0) {
      allMembers = allMembers.concat(members.map((m) => m.username));
      totalMembers = members.length;
    } else {
      totalMembers = 0;
    }
    page++;
  } while (totalMembers > 0);
  return allMembers;
}
async function getAllGroups(usersAPI, userId, config, options) {
  const querySize = options?.groupQuerySize || 100;
  let allGroups = [];
  let page = 0;
  let totalGroups = 0;
  do {
    const users = await usersAPI();
    const groups = await users.listGroups({
      id: userId,
      max: querySize,
      realm: config.realm,
      first: page * querySize
    });
    if (groups.length > 0) {
      allGroups = allGroups.concat(...groups);
      totalGroups = groups.length;
    } else {
      totalGroups = 0;
    }
    page++;
  } while (totalGroups > 0);
  return allGroups;
}
async function getServerVersion(kcAdminClient) {
  const serverInfo = await kcAdminClient.serverInfo.find();
  const serverVersion = parseInt(
    serverInfo.systemInfo?.version?.slice(0, 2) || "",
    10
  );
  return serverVersion;
}
async function processGroupsRecursively(kcAdminClient, config, logger, topLevelGroups) {
  const allGroups = [];
  const brief = config.briefRepresentation ?? constants.KEYCLOAK_BRIEF_REPRESENTATION_DEFAULT;
  for (const group of topLevelGroups) {
    allGroups.push(group);
    if (group.subGroupCount > 0) {
      await authenticate.ensureTokenValid(kcAdminClient, config, logger);
      const subgroups = await kcAdminClient.groups.listSubGroups({
        parentId: group.id,
        first: 0,
        max: group.subGroupCount,
        briefRepresentation: brief,
        realm: config.realm
      });
      const subGroupResults = await processGroupsRecursively(
        kcAdminClient,
        config,
        logger,
        subgroups
      );
      allGroups.push(...subGroupResults);
    }
  }
  return allGroups;
}
function* traverseGroups(group) {
  yield group;
  for (const g of group.subGroups ?? []) {
    g.parent = group.name;
    yield* traverseGroups(g);
  }
}
const readKeycloakRealm = async (client, config, logger, limit, taskInstanceId, dataBatchFailureCounter, options) => {
  const kUsers = await getEntities(
    async () => {
      await authenticate.ensureTokenValid(client, config, logger);
      return client.users;
    },
    config,
    logger,
    dataBatchFailureCounter,
    taskInstanceId,
    limit,
    options?.userQuerySize
  );
  logger.debug(`Fetched ${kUsers.length} users from Keycloak`);
  const topLevelKGroups = await getEntities(
    async () => {
      await authenticate.ensureTokenValid(client, config, logger);
      return client.groups;
    },
    config,
    logger,
    dataBatchFailureCounter,
    taskInstanceId,
    limit,
    options?.groupQuerySize
  );
  logger.debug(`Fetched ${topLevelKGroups.length} groups from Keycloak`);
  let serverVersion;
  try {
    serverVersion = await getServerVersion(client);
  } catch (error) {
    throw new Error(`Failed to retrieve Keycloak server information: ${error}`);
  }
  const isVersion23orHigher = serverVersion >= 23;
  let rawKGroups = [];
  logger.debug(`Processing groups recursively`);
  if (isVersion23orHigher) {
    rawKGroups = await processGroupsRecursively(
      client,
      config,
      logger,
      topLevelKGroups
    );
  } else {
    rawKGroups = topLevelKGroups.reduce(
      (acc, g) => acc.concat(...traverseGroups(g)),
      []
    );
  }
  logger.debug(`Fetching group members for keycloak groups and list subgroups`);
  const brief = config.briefRepresentation ?? constants.KEYCLOAK_BRIEF_REPRESENTATION_DEFAULT;
  const kGroups = await Promise.all(
    rawKGroups.map(
      (g) => limit(async () => {
        g.members = await getAllGroupMembers(
          async () => {
            await authenticate.ensureTokenValid(client, config, logger);
            return client.groups;
          },
          g.id,
          config,
          options
        );
        if (isVersion23orHigher) {
          if (g.subGroupCount > 0) {
            await authenticate.ensureTokenValid(client, config, logger);
            g.subGroups = await client.groups.listSubGroups({
              parentId: g.id,
              first: 0,
              max: g.subGroupCount,
              briefRepresentation: brief,
              realm: config.realm
            });
          }
          if (g.parentId) {
            await authenticate.ensureTokenValid(client, config, logger);
            const groupParent = await client.groups.findOne({
              id: g.parentId,
              realm: config.realm
            });
            g.parent = groupParent?.name;
          }
        }
        return g;
      })
    )
  );
  logger.debug(`Parsing groups`);
  const parsedGroups = await Promise.all(
    kGroups.map(async (g) => {
      if (!g) {
        return null;
      }
      const entity = await parseGroup(
        g,
        config.realm,
        options?.groupTransformer
      );
      if (entity) {
        return { ...g, entity };
      }
      return null;
    })
  );
  const filteredParsedGroups = parsedGroups.filter(
    (group) => group !== null
  );
  const groupIndex = /* @__PURE__ */ new Map();
  filteredParsedGroups.forEach((group) => {
    if (group.members) {
      group.members.forEach((member) => {
        if (!groupIndex.has(member)) {
          groupIndex.set(member, []);
        }
        groupIndex.get(member)?.push(group.entity.metadata.name);
      });
    }
  });
  logger.debug("Parsing users");
  const parsedUsers = await Promise.all(
    kUsers.map(async (u) => {
      if (!u) {
        return null;
      }
      const entity = await parseUser(
        u,
        config.realm,
        filteredParsedGroups,
        groupIndex,
        options?.userTransformer
      );
      if (entity) {
        return { ...u, entity };
      }
      return null;
    })
  );
  const filteredParsedUsers = parsedUsers.filter(
    (user) => user !== null
  );
  logger.debug(`Set up group members and children information`);
  const userMap = new Map(
    filteredParsedUsers.map((user) => [user.username, user.entity.metadata.name])
  );
  const groupMap = new Map(
    filteredParsedGroups.map((group) => [group.name, group.entity.metadata.name])
  );
  const groups = filteredParsedGroups.map((g) => {
    const entity = g.entity;
    entity.spec.members = g.entity.spec.members?.flatMap((m) => userMap.get(m) ?? []) ?? [];
    entity.spec.children = g.entity.spec.children?.flatMap((c) => groupMap.get(c) ?? []) ?? [];
    entity.spec.parent = groupMap.get(entity.spec.parent);
    return entity;
  });
  logger.info(
    `Prepared to ingest  ${parsedUsers.length} users and ${groups.length} groups into the catalog from Keycloak`
  );
  return { users: filteredParsedUsers.map((u) => u.entity), groups };
};

exports.getAllGroupMembers = getAllGroupMembers;
exports.getAllGroups = getAllGroups;
exports.getEntities = getEntities;
exports.getServerVersion = getServerVersion;
exports.parseGroup = parseGroup;
exports.parseUser = parseUser;
exports.processGroupsRecursively = processGroupsRecursively;
exports.readKeycloakRealm = readKeycloakRealm;
exports.traverseGroups = traverseGroups;
//# sourceMappingURL=read.cjs.js.map
