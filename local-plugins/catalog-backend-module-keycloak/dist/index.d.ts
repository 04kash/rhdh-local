import * as _backstage_backend_plugin_api from '@backstage/backend-plugin-api';
import { SchedulerServiceTaskScheduleDefinition, SchedulerServiceTaskRunner, SchedulerService, LoggerService, AuthService, DiscoveryService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { EntityProvider, EntityProviderConnection } from '@backstage/plugin-catalog-node';
import { GroupEntity, UserEntity } from '@backstage/catalog-model';
import GroupRepresentation from '@keycloak/keycloak-admin-client/lib/defs/groupRepresentation';
import UserRepresentation from '@keycloak/keycloak-admin-client/lib/defs/userRepresentation';
import { EventsService } from '@backstage/plugin-events-node';
import { CatalogApi } from '@backstage/catalog-client';

/**
 * @public
 * The Keycloak group representation with parent and group members information.
 */
interface GroupRepresentationWithParent extends GroupRepresentation {
    /**
     * The parent group ID.
     */
    parentId?: string;
    /**
     * The parent group name.
     */
    parent?: string;
    /**
     * The group members.
     */
    members?: string[];
}
/**
 * @public
 * The Keycloak group representation with parent, group members, and conrresponding backstage entity information.
 */
interface GroupRepresentationWithParentAndEntity extends GroupRepresentationWithParent {
    /**
     * The corresponding backstage entity information.
     */
    entity: GroupEntity;
}
/**
 * @public
 * The Keycloak user representation with corresponding backstage entity information.
 */
interface UserRepresentationWithEntity extends UserRepresentation {
    /**
     * The corresponding backstage entity information.
     */
    entity: UserEntity;
}
/**
 * Customize the ingested User entity.
 *
 * @public
 *
 * @param entity - The output of the default parser.
 * @param user - The Keycloak user representation.
 * @param realm - The realm name.
 * @param groups - Data about available groups, which can be used to create additional relationships.
 *
 * @returns A promise resolving to a modified `UserEntity` object to be ingested into the catalog,
 * or `undefined` to reject the entity.
 */
type UserTransformer = (entity: UserEntity, user: UserRepresentation, realm: string, groups: GroupRepresentationWithParentAndEntity[]) => Promise<UserEntity | undefined>;
/**
 * Customize the ingested Group entity.
 *
 * @public
 *
 * @param entity - The output of the default parser.
 * @param group - The Keycloak group representation.
 * @param realm - The realm name.
 *
 * @returns A promise resolving to a modified `GroupEntity` object to be ingested into the catalog,
 * or `undefined` to reject the entity.
 */
type GroupTransformer = (entity: GroupEntity, group: GroupRepresentation, realm: string) => Promise<GroupEntity | undefined>;

/**
 * The configuration parameters for a single Keycloak provider.
 *
 * @public
 */
type KeycloakProviderConfig = {
    /**
     * Identifier of the provider which will be used i.e. at the location key for ingested entities.
     */
    id: string;
    /**
     * The Keycloak base URL
     */
    baseUrl: string;
    /**
     * The username to use for authenticating requests
     * If specified, password must also be specified
     */
    username?: string;
    /**
     * The password to use for authenticating requests
     * If specified, username must also be specified
     */
    password?: string;
    /**
     * The clientId to use for authenticating requests
     * If specified, clientSecret must also be specified
     */
    clientId?: string;
    /**
     * The clientSecret to use for authenticating requests
     * If specified, clientId must also be specified
     */
    clientSecret?: string;
    /**
     * name of the Keycloak realm
     */
    realm: string;
    /**
     * name of the Keycloak login realm
     */
    loginRealm?: string;
    /**
     * Schedule configuration for refresh tasks.
     */
    schedule?: SchedulerServiceTaskScheduleDefinition;
    /**
     * The number of users to query at a time.
     * @defaultValue 100
     * @remarks
     * This is a performance optimization to avoid querying too many users at once.
     * @see https://www.keycloak.org/docs-api/11.0/rest-api/index.html#_users_resource
     */
    userQuerySize?: number;
    /**
     * The number of groups to query at a time.
     * @defaultValue 100
     * @remarks
     * This is a performance optimization to avoid querying too many groups at once.
     * @see https://www.keycloak.org/docs-api/11.0/rest-api/index.html#_groups_resource
     */
    groupQuerySize?: number;
    /**
     * Maximum request concurrency to prevent DoS attacks on the Keycloak server.
     */
    maxConcurrency?: number;
    /**
     * Whether the API call will return a brief representation for groups and users or not. Defaults to true.
     * A complete representation will include additional attributes
     * @defaultValue true
     */
    briefRepresentation?: boolean;
};

/**
 * Options for {@link KeycloakOrgEntityProvider}.
 *
 * @public
 */
interface KeycloakOrgEntityProviderOptions {
    /**
     * A unique, stable identifier for this provider.
     *
     * @example "production"
     */
    id: string;
    /**
     * The refresh schedule to use.
     * @remarks
     *
     * You can pass in the result of
     * {@link @backstage/backend-plugin-api#SchedulerService.createScheduledTaskRunner}
     * to enable automatic scheduling of tasks.
     */
    schedule?: SchedulerServiceTaskRunner;
    /**
     * Scheduler used to schedule refreshes based on
     * the schedule config.
     */
    scheduler?: SchedulerService;
    /**
     * The logger to use.
     */
    logger: LoggerService;
    /**
     * The function that transforms a user entry in LDAP to an entity.
     */
    userTransformer?: UserTransformer;
    /**
     * The function that transforms a group entry in LDAP to an entity.
     */
    groupTransformer?: GroupTransformer;
}
/**
 * Ingests org data (users and groups) from Keycloak.
 *
 * @public
 */
declare class KeycloakOrgEntityProvider implements EntityProvider {
    private options;
    private connection?;
    private meter;
    private counter;
    private scheduleFn?;
    private readonly events?;
    private readonly catalogApi;
    /**
     * Static builder method to create multiple KeycloakOrgEntityProvider instances from a single config.
     * @param deps - The dependencies required for the provider, including the configuration and logger.
     * @param options - Options for scheduling tasks and transforming users and groups.
     * @returns An array of KeycloakOrgEntityProvider instances.
     */
    static fromConfig(deps: {
        config: Config;
        logger: LoggerService;
        catalogApi?: CatalogApi;
        events?: EventsService;
        auth: AuthService;
        discovery: DiscoveryService;
    }, options: ({
        schedule: SchedulerServiceTaskRunner;
    } | {
        scheduler: SchedulerService;
    }) & {
        userTransformer?: UserTransformer;
        groupTransformer?: GroupTransformer;
    }): KeycloakOrgEntityProvider[];
    constructor(options: {
        id: string;
        provider: KeycloakProviderConfig;
        logger: LoggerService;
        taskRunner: SchedulerServiceTaskRunner;
        events?: EventsService;
        catalogApi?: CatalogApi;
        discovery: DiscoveryService;
        auth: AuthService;
        userTransformer?: UserTransformer;
        groupTransformer?: GroupTransformer;
    });
    /**
     * Returns the name of this entity provider.
     */
    getProviderName(): string;
    /**
     * Connect to Backstage catalog entity provider
     * @param connection - The connection to the catalog API ingestor, which allows the provision of new entities.
     */
    connect(connection: EntityProviderConnection): Promise<void>;
    private addEntitiesOperation;
    private removeEntitiesOperation;
    private onUserEvent;
    private handleUserCreate;
    private handleUserDelete;
    private onUserEdit;
    private onMembershipChange;
    private onGroupEvent;
    private handleGroupCreate;
    private handleGroupDelete;
    private getParentEntityRef;
    private getSubgroupRefs;
    private getEntitiesByRefs;
    private collectUserMemberships;
    private updateUserEntitiesAfterGroupDelete;
    private createGroupEntities;
    /**
     * Runs one complete ingestion loop. Call this method regularly at some
     * appropriate cadence.
     */
    read(options: {
        logger?: LoggerService;
        taskInstanceId: string;
    }): Promise<void>;
    /**
     * Periodically schedules a task to read Keycloak user and group information, parse it, and provision it to the Backstage catalog.
     * @param taskRunner - The task runner to use for scheduling tasks.
     */
    schedule(taskRunner: SchedulerServiceTaskRunner): void;
}

/**
 * @public
 * Group transformer that does nothing.
 */
declare const noopGroupTransformer: GroupTransformer;
/**
 * @public
 * User transformer that does nothing.
 */
declare const noopUserTransformer: UserTransformer;
/**
 * @public
 * User transformer that sanitizes .metadata.name from email address to a valid name
 */
declare const sanitizeEmailTransformer: UserTransformer;

/**
 * An extension point that exposes the ability to implement user and group transformer functions for keycloak.
 *
 * @public
 */
declare const keycloakTransformerExtensionPoint: _backstage_backend_plugin_api.ExtensionPoint<KeycloakTransformerExtensionPoint>;
/**
 * The interface for {@link keycloakTransformerExtensionPoint}.
 *
 * @public
 */
type KeycloakTransformerExtensionPoint = {
    setUserTransformer(userTransformer: UserTransformer): void;
    setGroupTransformer(groupTransformer: GroupTransformer): void;
};

/**
 * Registers the `KeycloakEntityProvider` with the catalog processing extension point.
 *
 * @public
 */
declare const catalogModuleKeycloakEntityProvider: _backstage_backend_plugin_api.BackendFeature;

export { type GroupRepresentationWithParent, type GroupRepresentationWithParentAndEntity, type GroupTransformer, KeycloakOrgEntityProvider, type KeycloakOrgEntityProviderOptions, type KeycloakProviderConfig, type KeycloakTransformerExtensionPoint, type UserRepresentationWithEntity, type UserTransformer, catalogModuleKeycloakEntityProvider as default, keycloakTransformerExtensionPoint, noopGroupTransformer, noopUserTransformer, sanitizeEmailTransformer };
