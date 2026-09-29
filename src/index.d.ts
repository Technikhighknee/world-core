export type EntityId = string | number;
export type NavigationId = string;

export interface Vec2 {
    x: number;
    y: number;
}

export interface Body {
    radius?: number;
    [key: string]: unknown;
}

export interface Mobility {
    profileId?: string;
    cacheKey?: string;
    speed: number;
    surfaceMultipliers?: Readonly<Record<string, number>>;
    requiredRoadWidth?: number;
    requiredRoadTags?: readonly string[];
    blockedRoadTags?: readonly string[];
    localSteering?: boolean;
    navigationEntryMaxDistance?: number;
    [key: string]: unknown;
}

export interface RouteLeg {
    roadId: NavigationId;
    reversed: boolean;
    roadVersion: number;
    startSegmentIndex?: number;
}

export interface Route {
    startNodeId: NavigationId;
    destinationNodeId: NavigationId;
    legs: RouteLeg[];
    estimatedSeconds: number;
}

export interface Journey {
    destinationNodeId: NavigationId;
    route: Route;
    prefixLeg: RouteLeg | null;
    entryPoint: Vec2 | null;
    legIndex: number;
    pointIndex: number;
    validatedGraphRevision: number;
    roadEntered?: boolean;
}

export interface Entity {
    id: EntityId;
    position: Vec2;
    domainId?: string;
    kind?: string;
    body?: Body;
    mobility?: Mobility;
    journey?: Journey | null;
    simulation?: Record<string, unknown>;
    lastJourneyFailure?: {
        destinationNodeId: NavigationId | null;
        reason: string;
        time: number;
    };
    [key: string]: unknown;
}

export interface NavigationNode {
    id: NavigationId;
    position: Vec2;
    junctionRadius: number;
    regionId: string | null;
    componentId: number;
}

export interface NavigationRegion {
    id: string;
    nodeIds: Set<NavigationId>;
}

export interface Road {
    id: NavigationId;
    from: NavigationId;
    to: NavigationId;
    width: number;
    surface: string;
    bidirectional: boolean;
    enabled: boolean;
    allowedProfiles: string[] | null;
    blockedProfiles: string[];
    tags: string[];
    points: Vec2[];
    length: number;
    version: number;
}

export interface RoadEffect {
    blocked: boolean;
    costMultiplier: number;
}

export interface RoutePlan {
    route: Route;
    prefixLeg: RouteLeg | null;
    entryPoint: Vec2 | null;
    estimatedSeconds: number;
}

export interface RoadHit {
    road: Road;
    point: Vec2;
    distance: number;
    distanceAlong: number;
    segmentIndex: number;
}

export type NavigationEntry =
    | {
        kind: "node";
        id: NavigationId;
        node: NavigationNode;
        point: Vec2;
        distance: number;
    }
    | ({
        kind: "road";
        id: NavigationId;
        road: Road;
    } & Omit<RoadHit, "road">);

export interface MovementLodTier {
    maxDistance: number;
    interval: number;
}

export interface SimulationRegion {
    id: string;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    priority: number;
    detailLevel: string;
    movementInterval: number | null;
    enabled: boolean;
}

export interface SimulationRegionInput {
    id: string;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    priority?: number;
    detailLevel?: string;
    movementInterval?: number | null;
    enabled?: boolean;
}

export interface LocalSteeringOptions {
    enabled?: boolean;
    neighborRadius?: number;
    separationGap?: number;
    separationStrength?: number;
    maxLateralSpeed?: number;
    centeringRate?: number;
    counterflowStrength?: number;
    trafficSide?: "right" | "left";
    obstacleLookahead?: number;
    obstacleMargin?: number;
    obstacleStrength?: number;
    obstacleForwardPressure?: number;
    roadEdgeMargin?: number;
    congestionThreshold?: number;
    congestionStrength?: number;
    forwardPressureWeight?: number;
    minSpeedMultiplier?: number;
}

export interface LocalSteeringConfig extends Required<LocalSteeringOptions> {}

export type EventOverflowPolicy =
    | "drop-newest"
    | "drop-oldest"
    | "throw";

export interface WorldDomainInput {
    id: string;
}

export interface WorldDomain {
    id: string;
    readonly handle: number;
    readonly entityCount: number;
    readonly maxEntityRadius: number;
}

export interface WorldOptions {
    spatialCellSize?: number;
    obstacleCellSize?: number;
    movementLodTiers?: readonly MovementLodTier[] | null;
    interestPoints?: readonly Vec2[];
    simulationRegions?: readonly SimulationRegionInput[];
    domains?: readonly WorldDomainInput[];
    localSteering?: LocalSteeringOptions | null;
    captureEvents?: boolean;
    eventQueueLimit?: number;
    eventOverflowPolicy?: EventOverflowPolicy;
}

export interface WorldEvent {
    time: number;
    type: string;
    entityId?: EntityId;
    roadId?: NavigationId;
    destinationNodeId?: NavigationId | null;
    reason?: string | null;
    [key: string]: unknown;
}

export type Obstacle =
    | {
        id: EntityId;
        type: "circle";
        center: Vec2;
        radius: number;
        enabled?: boolean;
        temporary?: boolean;
        tags?: string[];
        version?: number;
    }
    | {
        id: EntityId;
        type: "aabb";
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        enabled?: boolean;
        temporary?: boolean;
        tags?: string[];
        version?: number;
    }
    | {
        id: EntityId;
        type: "segment";
        a: Vec2;
        b: Vec2;
        radius?: number;
        enabled?: boolean;
        temporary?: boolean;
        tags?: string[];
        version?: number;
    };

export interface SpatialQueryBuffer<T extends Entity = Entity> {
    candidates: Set<EntityId>;
    results: T[];
}

export interface EntityQueryOptions<T extends Entity = Entity> {
    excludeId?: EntityId | null;
    predicate?: ((entity: T) => boolean) | null;
    domainId?: string | null;
}

export interface NearestEntityResult<T extends Entity = Entity> {
    entity: T;
    distance: number;
    centerDistance: number;
}

export interface WorldDiagnostics {
    entityCount: number;
    spatialIndexedEntities: number;
    spatialCellCount: number;
    spatialMemberships: number;
    spatialMultiOccupancyCells: number;
    domainCount: number;
    occupiedSpatialDomainCount: number;
    movingEntities: number;
    movementIntervalEntries: number;
    movementBucketCount: number;
    movementBucketMemberships: number;
    radiusTrackedEntities: number;
    radiusCountEntries: number;
    maxEntityRadius: number;
    obstacleCount: number;
    obstacleIndexMemberships: number;
    occupiedObstacleDomainCount: number;
    eventQueueSize: number;
    eventQueueLimit: number;
    droppedEventCount: number;
    simulationRegionCount: number;
    scheduledSimulationRegionCount: number;
}

export const DEFAULT_WORLD_DOMAIN_ID: "default";

export class World<T extends Entity = Entity> {
    constructor(options?: WorldOptions);

    time: number;
    readonly entities: Map<EntityId, T>;
    readonly domains: Map<string, WorldDomain>;
    readonly movingEntities: Map<EntityId, T>;
    captureEvents: boolean;
    eventQueueLimit: number;
    eventOverflowPolicy: EventOverflowPolicy;
    droppedEventCount: number;
    localSteering: LocalSteeringConfig | { enabled: false } | null;
    interestPoints: Vec2[];
    readonly simulationRegions: Map<string, SimulationRegion>;

    configureEventQueue(options?: {
        limit?: number;
        overflowPolicy?: EventOverflowPolicy;
    }): {
        limit: number;
        overflowPolicy: EventOverflowPolicy;
    };
    getEventQueueStats(): {
        size: number;
        limit: number;
        overflowPolicy: EventOverflowPolicy;
        dropped: number;
    };
    resetDroppedEventCount(): number;
    setEventCapture(enabled: boolean): void;
    emitEvent(type: string, data?: Record<string, unknown>): WorldEvent | null;
    drainEvents(target?: WorldEvent[]): WorldEvent[];
    peekEvents(): WorldEvent[];

    addObstacle(
        obstacle: Obstacle,
        options?: { domainId?: string },
    ): Obstacle;
    getObstacle(obstacleId: EntityId): Obstacle | undefined;
    getObstacleDomain(obstacleId: EntityId): string | null;
    removeObstacle(obstacleId: EntityId): boolean;
    setObstacleEnabled(obstacleId: EntityId, enabled: boolean): boolean;
    replaceObstacle(obstacleId: EntityId, patch: Partial<Obstacle>): Obstacle;
    queryObstaclesRadiusInto(
        position: Vec2,
        radius: number,
        results?: Obstacle[],
        options?: {
            includeDisabled?: boolean;
            predicate?: ((obstacle: Obstacle) => boolean) | null;
            domainId?: string;
        },
    ): Obstacle[];

    addDomain(input: WorldDomainInput): WorldDomain;
    removeDomain(domainId: string): boolean;
    getDomain(domainId: string): WorldDomain | undefined;
    getEntityDomain(entityId: EntityId): WorldDomain | null;

    addEntity(entity: T): T;
    removeEntity(entityId: EntityId): boolean;
    getEntity(entityId: EntityId): T | undefined;
    transferEntity(
        entityId: EntityId,
        target: {
            domainId: string;
            position: Vec2;
        },
    ): T;
    setPosition(entityId: EntityId, position: Vec2): void;
    setPositionXY(entityId: EntityId, x: number, y: number): void;
    setEntityPositionXY(entity: T, x: number, y: number): void;
    setEntityRadius(entityId: EntityId, radius: number): void;

    configureLocalSteering(options?: LocalSteeringOptions): LocalSteeringConfig;
    disableLocalSteering(): void;

    addSimulationRegion(
        region: SimulationRegionInput,
        options?: { refresh?: boolean },
    ): SimulationRegion;
    replaceSimulationRegion(
        regionId: string,
        patch: Partial<SimulationRegionInput>,
    ): SimulationRegion;
    removeSimulationRegion(regionId: string): boolean;
    simulationRegionAt(position: Vec2): SimulationRegion | null;
    getEntitySimulationRegion(entityId: EntityId): SimulationRegion | null;

    configureMovementLod(tiers: readonly MovementLodTier[]): void;
    setInterestPoints(points: readonly Vec2[]): void;
    setMovementInterval(entityId: EntityId, interval: number): void;
    clearMovementInterval(entityId: EntityId): void;
    hasDynamicMovementLod(): boolean;
    refreshAllMovementLod(): void;

    createSpatialQueryBuffer(): SpatialQueryBuffer<T>;
    queryRadiusInto(
        position: Vec2,
        radius: number,
        buffer: SpatialQueryBuffer<T>,
        options?: EntityQueryOptions<T>,
    ): T[];
    queryRadius(
        position: Vec2,
        radius: number,
        options?: EntityQueryOptions<T>,
    ): T[];
    queryAabbInto(
        minX: number,
        minY: number,
        maxX: number,
        maxY: number,
        buffer: SpatialQueryBuffer<T>,
        options?: EntityQueryOptions<T>,
    ): T[];
    queryAabb(
        minX: number,
        minY: number,
        maxX: number,
        maxY: number,
        options?: EntityQueryOptions<T>,
    ): T[];
    queryCapsuleInto(
        a: Vec2,
        b: Vec2,
        radius: number,
        buffer: SpatialQueryBuffer<T>,
        options?: EntityQueryOptions<T>,
    ): T[];
    queryCapsule(
        a: Vec2,
        b: Vec2,
        radius: number,
        options?: EntityQueryOptions<T>,
    ): T[];
    querySegmentInto(
        a: Vec2,
        b: Vec2,
        buffer: SpatialQueryBuffer<T>,
        options?: EntityQueryOptions<T>,
    ): T[];
    querySegment(
        a: Vec2,
        b: Vec2,
        options?: EntityQueryOptions<T>,
    ): T[];
    queryNearest(
        position: Vec2,
        options?: {
            maxDistance?: number;
            excludeId?: EntityId | null;
            predicate?: ((entity: T) => boolean) | null;
            domainId?: string | null;
        },
    ): NearestEntityResult<T> | null;

    getDiagnostics(): WorldDiagnostics;
    assertInternalConsistency(): WorldDiagnostics;
}

export interface NavigationRegistryDiagnostics {
    topologyCount: number;
    boundDomainCount: number;
    referencedTopologyCount: number;
    defaultTopologyId: string | null;
}

export class NavigationRegistry {
    constructor(options?: {
        defaultTopologyId?: string | null;
    });

    readonly topologies: Map<string, Navigation>;
    readonly domainBindings: Map<string, string>;
    defaultTopologyId: string | null;

    registerTopology(id: string, navigation: Navigation): Navigation;
    removeTopology(id: string): boolean;
    setDefaultTopology(id: string): void;
    bindDomain(domainId: string, topologyId: string): Navigation;
    unbindDomain(domainId: string): boolean;
    topologyIdForDomain(domainId?: string): string | null;
    navigationForDomain(domainId?: string): Navigation | null;
    navigationForEntity(entity: Entity): Navigation | null;
    getDiagnostics(): NavigationRegistryDiagnostics;
    assertInternalConsistency(): NavigationRegistryDiagnostics;
}

export type NavigationSource =
    | Navigation
    | NavigationRegistry;

export interface NavigationOptions {
    spatialCellSize?: number;
    routeCacheSize?: number;
    routeCacheMaxLegs?: number;
    routeCacheMaxTotalLegs?: number;
    hierarchicalRouteCacheSize?: number;
    regionalRouteCacheSize?: number;
}

export interface NavigationDiagnostics {
    nodeCount: number;
    roadCount: number;
    regionCount: number;
    regionAssignedNodes: number;
    regionGatewayCount: number;
    hierarchicalRouteCacheSize: number;
    regionalRouteCacheSize: number;
    roadEffectRoadCount: number;
    roadEffectCount: number;
    adjacencyNodeCount: number;
    adjacencyEdgeCount: number;
    componentCount: number;
    nodeIndexItemCount: number;
    nodeIndexMemberships: number;
    roadIndexItemCount: number;
    roadIndexMemberships: number;
    routeCacheSize: number;
    routeCacheLegCount: number;
    graphRevision: number;
    maxRoadHalfWidth: number;
}

export class Navigation {
    constructor(options?: NavigationOptions);

    readonly nodes: Map<NavigationId, NavigationNode>;
    readonly roads: Map<NavigationId, Road>;
    readonly roadEffects: Map<NavigationId, Map<string, RoadEffect>>;
    readonly regions: Map<string, NavigationRegion>;
    graphRevision: number;

    invalidateRoadRoutes(roadId: NavigationId): void;
    invalidateAllRoutes(): void;

    addRegion(input: { id: string }): NavigationRegion;
    removeRegion(regionId: string): boolean;
    setNodeRegion(nodeId: NavigationId, regionId: string | null): boolean;
    getRegionGateways(regionId: string): NavigationNode[];

    addNode(input: {
        id: NavigationId;
        x: number;
        y: number;
        junctionRadius?: number;
        regionId?: string | null;
    }): NavigationNode;
    setNodeJunctionRadius(nodeId: NavigationId, junctionRadius: number): boolean;
    removeNode(nodeId: NavigationId): boolean;

    addRoad(input: {
        id: NavigationId;
        from: NavigationId;
        to: NavigationId;
        shape?: readonly Vec2[];
        width?: number;
        surface?: string;
        bidirectional?: boolean;
        enabled?: boolean;
        allowedProfiles?: readonly string[] | null;
        blockedProfiles?: readonly string[];
        tags?: readonly string[];
    }): Road;
    removeRoad(roadId: NavigationId): boolean;
    setRoadEnabled(roadId: NavigationId, enabled: boolean): boolean;
    setRoadSurface(roadId: NavigationId, surface: string): boolean;
    setRoadWidth(roadId: NavigationId, width: number): boolean;
    setRoadAccess(
        roadId: NavigationId,
        access?: {
            allowedProfiles?: readonly string[] | null;
            blockedProfiles?: readonly string[];
            tags?: readonly string[];
        },
    ): boolean;
    setRoadBidirectional(roadId: NavigationId, bidirectional: boolean): boolean;
    replaceRoadGeometry(roadId: NavigationId, shape?: readonly Vec2[]): Road;

    setRoadEffect(
        effectId: string,
        roadId: NavigationId,
        effect?: Partial<RoadEffect>,
    ): boolean;
    removeRoadEffect(effectId: string, roadId: NavigationId): boolean;
    clearRoadEffect(effectId: string): boolean;
    roadCostMultiplier(road: NavigationId | Road): number;

    canTraverseRoad(road: NavigationId | Road, mobility: Mobility): boolean;
    isRouteLegCurrent(leg: RouteLeg, mobility: Mobility): boolean;
    isRouteCurrent(route: Route, mobility: Mobility, startLegIndex?: number): boolean;

    nodeAt(position: Vec2, tolerance?: number): NavigationNode | null;
    nearestNode(position: Vec2): NavigationNode | null;
    nearestNodeWithDistance(position: Vec2): {
        node: NavigationNode;
        distance: number;
    } | null;
    roadAt(
        position: Vec2,
        extraTolerance?: number,
        options?: {
            includeDisabled?: boolean;
        },
    ): RoadHit | null;

    findNavigationEntries(
        position: Vec2,
        mobility: Mobility,
        options?: {
            maxDistance?: number;
            maxEntries?: number;
        },
    ): NavigationEntry[];

    findRouteFromPosition(
        position: Vec2,
        destinationNodeId: NavigationId,
        mobility: Mobility,
        options?: JourneyStartOptions,
    ): RoutePlan | null;

    findHierarchicalRoute(
        startNodeId: NavigationId,
        destinationNodeId: NavigationId,
        mobility: Mobility,
    ): Route | null;

    findRoute(
        startNodeId: NavigationId,
        destinationNodeId: NavigationId,
        mobility: Mobility,
    ): Route | null;

    getDiagnostics(): NavigationDiagnostics;
    assertInternalConsistency(): NavigationDiagnostics;
}

export interface JourneyStartOptions {
    nodeTolerance?: number;
    roadTolerance?: number;
    entryMaxDistance?: number;
    maxEntryCandidates?: number;
}

export function startJourney(
    world: World,
    navigation: NavigationSource,
    entityId: EntityId,
    destinationNodeId: NavigationId,
    options?: JourneyStartOptions,
): boolean;

export function rerouteJourney(
    world: World,
    navigation: NavigationSource,
    entityId: EntityId,
    destinationNodeId: NavigationId,
    options?: JourneyStartOptions,
): boolean;

export function stopJourney(
    entity: Entity,
    world?: World | null,
): void;

export type SimulationSystem =
    (
        world: World,
        navigation: NavigationSource,
        deltaSeconds: number,
    ) => void;

export function stepSimulation(
    world: World,
    navigation: NavigationSource,
    deltaSeconds: number,
    systems?: readonly SimulationSystem[],
): void;

export const MOBILITY_PROFILES: Readonly<{
    pedestrian: Readonly<Mobility & {
        profileId: "pedestrian";
    }>;
    cart: Readonly<Mobility & {
        profileId: "cart";
    }>;
    horse: Readonly<Mobility & {
        profileId: "horse";
    }>;
}>;

export type BuiltInMobilityProfile =
    keyof typeof MOBILITY_PROFILES;

export function mobilityProfile(
    id: BuiltInMobilityProfile,
): Readonly<Mobility>;

export interface WorldCoreSnapshot {
    format: "world-core";
    version: number;
    navigation: Record<string, unknown>;
    world: Record<string, unknown>;
    routes: unknown[];
    entities: unknown[];
    entityOrder: EntityId[];
    movingOrder: EntityId[];
}

export function serializeWorldCore(
    world: World,
    navigation: NavigationSource,
): WorldCoreSnapshot;

export function deserializeWorldCore(
    snapshot: unknown,
): {
    world: World;
    navigation: NavigationSource;
};

export const WORLD_CORE_SNAPSHOT_VERSION: number;

export function validateWorldCoreSnapshot(
    snapshot: unknown,
    options?: {
        expectedFormat?: string;
        expectedVersion?: number;
    },
): true;

export interface WorldCoreStateHashes {
    overall: string;
    navigation: string;
    world: string;
    entities: string;
}

export function computeWorldCoreStateHash(
    world: World,
    navigation: NavigationSource,
): string;

export function computeWorldCoreStateHashes(
    world: World,
    navigation: NavigationSource,
): WorldCoreStateHashes;
