import type {
    Change,
    ClassConstructor,
    ListenerParams,
    NodeValue,
    Observable,
    ObservableObject,
    ObservableParam,
    TypeAtPath,
} from '@legendapp/state';
import {
    batch,
    constructObjectWithPath,
    deconstructObjectWithPath,
    endBatch,
    getNodeValue,
    internal,
    isEmpty,
    isFunction,
    isObject,
    isObservable,
    isPromise,
    isString,
    mergeIntoObservable,
    observable,
    setAtPath,
    setInObservableAtPath,
    when,
} from '@legendapp/state';
import type {
    FieldTransforms,
    LegacyPersistOptions,
    LegacyPersistOptionsLocal,
    LegacyPersistOptionsRemote,
    ObservablePersistPlugin,
    ObservablePersistRemoteClass,
    ObservablePersistRemoteFunctions,
    ObservablePersistState,
    PersistMetadata,
    PersistTransform,
} from '@legendapp/state/sync';
import { removeNullUndefined } from '../sync/syncHelpers';
import { observablePersistConfiguration } from './configureObservablePersistence';
import { invertFieldMap, transformObject, transformObjectWithPath, transformPath } from './fieldTransformer';
import { observablePersistRemoteFunctionsAdapter } from './observablePersistRemoteFunctionsAdapter';

const { globalState, symbolLinked, getNode } = internal;

export const mapPersistences: WeakMap<
    ClassConstructor<ObservablePersistPlugin | ObservablePersistRemoteClass>,
    {
        persist: ObservablePersistPlugin | ObservablePersistRemoteClass;
        initialized?: Observable<boolean>;
    }
> = new WeakMap();

const metadatas = new WeakMap<ObservableParam<any>, PersistMetadata>();
const promisesLocalSaves = new Set<Promise<void>>();

interface LocalState {
    persistenceLocal?: ObservablePersistPlugin;
    persistenceRemote?: ObservablePersistRemoteClass;
    pendingChanges?: Record<string, { p: any; v?: any; t: TypeAtPath[] }>;
    numSavesOutstanding?: number;
    pendingSaveResults?: object[];
    isApplyingPending?: boolean;
    timeoutSaveMetadata?: any;
}

interface PreppedChangeLocal {
    queuedChange: QueuedChange;
    changesLocal: ChangeWithPathStr[];
    saveRemote: boolean;
}

interface PreppedChangeRemote {
    queuedChange: QueuedChange;
    changesRemote: ChangeWithPathStr[];
}

type ChangeWithPathStr = Change & { pathStr: string };

function parseLocalConfig(config: string | LegacyPersistOptionsLocal | undefined): {
    table: string;
    config: LegacyPersistOptionsLocal;
} {
    return config
        ? isString(config)
            ? { table: config, config: { name: config } }
            : { table: config.name, config }
        : ({} as { table: string; config: LegacyPersistOptionsLocal });
}

function doInOrder<T>(arg1: T | Promise<T>, arg2: (value: T) => void): any {
    return isPromise(arg1) ? arg1.then(arg2) : arg2(arg1);
}

export function onChangeRemote(cb: () => void) {
    endBatch(true);
    // Remote changes should only update local state
    globalState.isLoadingRemote = true;

    batch(cb);

    globalState.isLoadingRemote = false;
}

export function transformOutData(
    value: any,
    path: string[],
    pathTypes: TypeAtPath[],
    { transform, fieldTransforms }: { transform?: PersistTransform; fieldTransforms?: FieldTransforms<any> },
): { value: any; path: string[] } | Promise<{ value: any; path: string[] }> {
    if (fieldTransforms || transform?.save) {
        const transformFn = () => {
            if (fieldTransforms) {
                const { obj, path: pathTransformed } = transformObjectWithPath(value, path, pathTypes, fieldTransforms);
                value = obj;
                path = pathTransformed;
            }

            return { value, path };
        };

        if (transform?.save) {
            const constructed = constructObjectWithPath(path, pathTypes, value);
            const saved = transform.save(constructed);
            const deconstruct = (toDeconstruct: boolean) => {
                value = deconstructObjectWithPath(path, pathTypes, toDeconstruct);
                return transformFn();
            };
            return doInOrder(saved, deconstruct);
        }
        return transformFn();
    }

    return { value, path };
}

export function transformLoadData(
    value: any,
    { transform, fieldTransforms }: { fieldTransforms?: FieldTransforms<any>; transform?: PersistTransform },
    doUserTransform: boolean,
): Promise<any> | any {
    if (fieldTransforms) {
        const inverted = invertFieldMap(fieldTransforms);
        value = transformObject(value, inverted);
    }

    if (doUserTransform && transform?.load) {
        value = transform.load(value);
    }

    return value;
}

async function updateMetadataImmediate<T>(
    obs: ObservableParam<any>,
    localState: LocalState,
    syncState: Observable<ObservablePersistState>,
    persistOptions: LegacyPersistOptions<T>,
    newMetadata: PersistMetadata,
) {
    const saves = Array.from(promisesLocalSaves);
    if (saves.length > 0) {
        await Promise.all(saves);
    }

    const { persistenceLocal } = localState;
    const local = persistOptions.local;
    const { table, config } = parseLocalConfig(local!);

    // Save metadata
    const oldMetadata: PersistMetadata | undefined = metadatas.get(obs);

    const { lastSync, pending } = newMetadata;

    const needsUpdate = pending || (lastSync && (!oldMetadata || lastSync !== oldMetadata.lastSync));

    if (needsUpdate) {
        const metadata = Object.assign({}, oldMetadata, newMetadata);
        metadatas.set(obs, metadata);
        if (persistenceLocal) {
            await persistenceLocal!.setMetadata(table, metadata, config);
        }

        if (lastSync) {
            syncState.assign({
                lastSync: lastSync,
                dateModified: lastSync,
            });
        }
    }
}

function updateMetadata<T>(
    obs: ObservableParam<any>,
    localState: LocalState,
    syncState: ObservableObject<ObservablePersistState>,
    persistOptions: LegacyPersistOptions<T>,
    newMetadata: PersistMetadata,
) {
    if (localState.timeoutSaveMetadata) {
        clearTimeout(localState.timeoutSaveMetadata);
    }
    localState.timeoutSaveMetadata = setTimeout(
        () =>
            updateMetadataImmediate(obs, localState, syncState, persistOptions as LegacyPersistOptions<T>, newMetadata),
        persistOptions?.remote?.metadataTimeout || 0,
    );
}

interface QueuedChange<T = any> {
    inRemoteChange: boolean;
    isApplyingPending: boolean;
    obs: Observable<T>;
    syncState: ObservableObject<ObservablePersistState>;
    localState: LocalState;
    persistOptions: LegacyPersistOptions<T>;
    changes: ListenerParams['changes'];
}

let _queuedChanges: QueuedChange[] = [];
let _queuedRemoteChanges: QueuedChange[] = [];
let timeoutSaveRemote: any = undefined;

function mergeChanges(changes: Change[]) {
    const changesByPath = new Map<string, Change>();
    const changesOut: Change[] = [];
    // TODO: This could be even more robust by going deeper into paths like the firebase plugin's _updatePendingSave
    for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        const pathStr = change.path.join('/');
        const existing = changesByPath.get(pathStr);
        if (existing) {
            existing.valueAtPath = change.valueAtPath;
        } else {
            changesByPath.set(pathStr, change);
            changesOut.push(change);
        }
    }
    return changesOut;
}

function mergeQueuedChanges(allChanges: QueuedChange[]) {
    const changesByObsRemote = new Map<Observable, Change[]>();
    const changesByObsLocal = new Map<Observable, Change[]>();

    const outRemote: Map<Observable, QueuedChange> = new Map();
    const outLocal: Map<Observable, QueuedChange> = new Map();
    for (let i = 0; i < allChanges.length; i++) {
        const value = allChanges[i];
        const { obs, changes, inRemoteChange } = value;
        const changesMap = inRemoteChange ? changesByObsRemote : changesByObsLocal;
        const existing = changesMap.get(obs);
        const newChanges = existing ? [...existing, ...changes] : changes;
        const merged = mergeChanges(newChanges);
        changesMap.set(obs, merged);
        value.changes = merged;
        (inRemoteChange ? outRemote : outLocal).set(obs, value);
    }
    return Array.from(outRemote.values()).concat(Array.from(outLocal.values()));
}

async function processQueuedChanges() {
    // Get a local copy of the queued changes and clear the global queue
    const queuedChanges = mergeQueuedChanges(_queuedChanges);
    _queuedChanges = [];

    _queuedRemoteChanges.push(...queuedChanges.filter((c) => !c.inRemoteChange));

    // Note: Summary of the order of operations these functions:
    // 1. Prepare all changes for saving. This may involve waiting for promises if the user has asynchronous transform.
    // We need to prepare all of the changes in the queue before saving so that the saves happen in the correct order,
    // since some may take longer to transformSaveData than others.
    // 2. Save pending to the metadata table first. If this is the only operation that succeeds, it would try to save
    // the current value again on next load, which isn't too bad.
    // 3. Save local changes to storage. If they never make it to remote, then on the next load they will be pending
    // and attempted again.
    // 4. Wait for remote load or error if allowed
    // 5. Save to remote
    // 6. On successful save, merge changes (if any) back into observable
    // 7. Lastly, update metadata to clear pending and update lastSync. Doing this earlier could potentially cause
    // sync inconsistences so it's very important that this is last.

    const preppedChangesLocal = await Promise.all(queuedChanges.map(prepChangeLocal));

    // TODO Clean this up: We only need to prep this now in ordre to save pending changes, don't need any of the other stuff. Should split that up?
    await Promise.all(queuedChanges.map(prepChangeRemote));

    await Promise.all(preppedChangesLocal.map(doChangeLocal));

    const timeout = observablePersistConfiguration?.remoteOptions?.debounceSet;
    if (timeout) {
        if (timeoutSaveRemote) {
            clearTimeout(timeoutSaveRemote);
        }

        timeoutSaveRemote = setTimeout(processQueuedRemoteChanges, timeout);
    } else {
        processQueuedRemoteChanges();
    }
}

async function processQueuedRemoteChanges() {
    const queuedRemoteChanges = mergeQueuedChanges(_queuedRemoteChanges);
    _queuedRemoteChanges = [];

    const preppedChangesRemote = await Promise.all(queuedRemoteChanges.map(prepChangeRemote));

    preppedChangesRemote.forEach(doChangeRemote);
}

async function prepChangeLocal(queuedChange: QueuedChange): Promise<PreppedChangeLocal | undefined> {
    const { syncState, changes, localState, persistOptions, inRemoteChange, isApplyingPending } = queuedChange;

    const local = persistOptions.local;
    const { persistenceRemote } = localState;
    const { config: configLocal } = parseLocalConfig(local!);
    const configRemote = persistOptions.remote;
    const saveLocal = local && !configLocal.readonly && !isApplyingPending && syncState.isEnabledLocal.peek();
    const saveRemote = !!(
        !inRemoteChange &&
        persistenceRemote?.set &&
        !configRemote?.readonly &&
        syncState.isEnabledRemote.peek()
    );

    if (saveLocal || saveRemote) {
        if (saveLocal && !syncState.isLoadedLocal.peek()) {
            console.error(
                '[legend-state] WARNING: An observable was changed before being loaded from persistence',
                local,
            );
            return undefined;
        }
        const changesLocal: ChangeWithPathStr[] = [];
        const changesPaths = new Set<string>();
        let promisesTransform: (void | Promise<any>)[] = [];

        // Reverse order
        for (let i = changes.length - 1; i >= 0; i--) {
            const { path } = changes[i];

            let found = false;

            // Optimization to only save the latest update at each path. We might have multiple changes at the same path
            // and we only need the latest value, so it starts from the end of the array, skipping any earlier changes
            // already processed. If a later change modifies a parent of an earlier change (which happens on delete()
            // it should be ignored as it's superseded by the parent modification.
            if (changesPaths.size > 0) {
                for (let u = 0; u < path.length; u++) {
                    if (changesPaths.has((u === path.length - 1 ? path : path.slice(0, u + 1)).join('/'))) {
                        found = true;
                        break;
                    }
                }
            }

            if (!found) {
                const pathStr = path.join('/');
                changesPaths.add(pathStr);

                const { prevAtPath, valueAtPath, pathTypes } = changes[i];
                if (saveLocal) {
                    const promiseTransformLocal = transformOutData(
                        valueAtPath,
                        path as string[],
                        pathTypes,
                        configLocal,
                    );

                    promisesTransform.push(
                        doInOrder(promiseTransformLocal, ({ path: pathTransformed, value: valueTransformed }) => {
                            // If path includes undefined there was a null in fieldTransforms so don't need to save it
                            if (!pathTransformed.includes(undefined as unknown as string)) {
                                // Prepare the local change with the transformed path/value
                                changesLocal.push({
                                    path: pathTransformed,
                                    pathTypes,
                                    prevAtPath,
                                    valueAtPath: valueTransformed,
                                    pathStr,
                                });
                            }
                        }),
                    );
                }
            }
        }

        // If there's any transform promises, wait for them before saving
        promisesTransform = promisesTransform.filter(Boolean);
        if (promisesTransform.length > 0) {
            await Promise.all(promisesTransform);
        }

        return { queuedChange, changesLocal, saveRemote };
    }
}
async function prepChangeRemote(queuedChange: QueuedChange): Promise<PreppedChangeRemote | undefined> {
    const { syncState, changes, localState, persistOptions, inRemoteChange, isApplyingPending } = queuedChange;

    const local = persistOptions.local;
    const { persistenceRemote } = localState;
    const { config: configLocal } = parseLocalConfig(local!);
    const configRemote = persistOptions.remote;
    const saveLocal = local && !configLocal.readonly && !isApplyingPending && syncState.isEnabledLocal.peek();
    const saveRemote =
        !inRemoteChange && persistenceRemote?.set && !configRemote?.readonly && syncState.isEnabledRemote.peek();

    if (saveLocal || saveRemote) {
        if (saveLocal && !syncState.isLoadedLocal.peek()) {
            console.error(
                '[legend-state] WARNING: An observable was changed before being loaded from persistence',
                local,
            );
            return undefined;
        }
        const changesRemote: ChangeWithPathStr[] = [];
        const changesPaths = new Set<string>();
        let promisesTransform: (void | Promise<any>)[] = [];

        // Reverse order
        for (let i = changes.length - 1; i >= 0; i--) {
            const { path } = changes[i];

            let found = false;

            // Optimization to only save the latest update at each path. We might have multiple changes at the same path
            // and we only need the latest value, so it starts from the end of the array, skipping any earlier changes
            // already processed. If a later change modifies a parent of an earlier change (which happens on delete()
            // it should be ignored as it's superseded by the parent modification.
            if (changesPaths.size > 0) {
                for (let u = 0; u < path.length; u++) {
                    if (changesPaths.has((u === path.length - 1 ? path : path.slice(0, u + 1)).join('/'))) {
                        found = true;
                        break;
                    }
                }
            }

            if (!found) {
                const pathStr = path.join('/');
                changesPaths.add(pathStr);

                const { prevAtPath, valueAtPath, pathTypes } = changes[i];

                if (saveRemote) {
                    const promiseTransformRemote = transformOutData(
                        valueAtPath,
                        path as string[],
                        pathTypes,
                        configRemote || {},
                    );

                    promisesTransform.push(
                        doInOrder(promiseTransformRemote, ({ path: pathTransformed, value: valueTransformed }) => {
                            // If path includes undefined there was a null in fieldTransforms so don't need to save it
                            if (!pathTransformed.includes(undefined as unknown as string)) {
                                // Prepare pending changes
                                if (!localState.pendingChanges) {
                                    localState.pendingChanges = {};
                                }

                                // First look for existing pending changes at a higher level than this change
                                // If they exist then merge this change into it
                                let found = false;
                                for (let i = 0; !found && i < path.length - 1; i++) {
                                    const pathParent = path.slice(0, i + 1).join('/');
                                    if (localState.pendingChanges[pathParent]?.v) {
                                        found = true;
                                        const pathChild = path.slice(i + 1);
                                        const pathTypesChild = pathTypes.slice(i + 1);
                                        setAtPath(
                                            localState.pendingChanges[pathParent].v,
                                            pathChild,
                                            pathTypesChild,
                                            valueAtPath,
                                        );
                                    }
                                }
                                if (!found) {
                                    // If an existing pending change is deeper than this change, just delete it
                                    // in favor of this wider change
                                    for (const key in localState.pendingChanges) {
                                        if (key !== pathStr && key.startsWith(pathStr)) {
                                            delete localState.pendingChanges[key];
                                        }
                                    }
                                    // The "p" saved in pending should be the previous state before changes,
                                    // so don't overwrite it if it already exists
                                    if (!localState.pendingChanges[pathStr]) {
                                        localState.pendingChanges[pathStr] = { p: prevAtPath ?? null, t: pathTypes };
                                    }

                                    // Pending value is the untransformed value because it gets loaded without transformment
                                    // and forwarded through to onObsChange where it gets transformed before save
                                    localState.pendingChanges[pathStr].v = valueAtPath;
                                }

                                // Prepare the remote change with the transformed path/value
                                changesRemote.push({
                                    path: pathTransformed,
                                    pathTypes,
                                    prevAtPath,
                                    valueAtPath: valueTransformed,
                                    pathStr,
                                });
                            }
                        }),
                    );
                }
            }
        }

        // If there's any transform promises, wait for them before saving
        promisesTransform = promisesTransform.filter(Boolean);
        if (promisesTransform.length > 0) {
            await Promise.all(promisesTransform);
        }

        return { queuedChange, changesRemote };
    }
}

async function doChangeLocal(changeInfo: PreppedChangeLocal | undefined) {
    if (!changeInfo) return;

    const { queuedChange, changesLocal, saveRemote } = changeInfo;
    const { obs, syncState, localState, persistOptions } = queuedChange;
    const { persistenceLocal } = localState;

    const local = persistOptions.local;
    const { table, config: configLocal } = parseLocalConfig(local!);
    const configRemote = persistOptions.remote;
    const shouldSaveMetadata = local && configRemote?.offlineBehavior === 'retry';

    if (saveRemote && shouldSaveMetadata) {
        // First save pending changes before saving local or remote
        await updateMetadataImmediate(obs, localState, syncState, persistOptions, {
            pending: localState.pendingChanges,
        });
    }

    if (changesLocal.length > 0) {
        // Save the changes to local persistence before saving to remote. They are already marked as pending so
        // if remote sync fails or the app is closed before remote sync, it will attempt to sync them on the next load.
        let promiseSet = persistenceLocal!.set(table, changesLocal, configLocal);

        if (promiseSet) {
            promiseSet = promiseSet.then(() => {
                promisesLocalSaves.delete(promiseSet as Promise<any>);
            });
            // Keep track of local save promises so that updateMetadata runs only after everything is saved
            promisesLocalSaves.add(promiseSet);

            // await the local save before proceeding to save remotely
            await promiseSet;
        }
    }
}
async function doChangeRemote(changeInfo: PreppedChangeRemote | undefined) {
    if (!changeInfo) return;

    const { queuedChange, changesRemote } = changeInfo;
    const { obs, syncState, localState, persistOptions } = queuedChange;
    const { persistenceLocal, persistenceRemote } = localState;

    const local = persistOptions.local;
    const { table, config: configLocal } = parseLocalConfig(local!);
    const { offlineBehavior, allowSetIfError, onBeforeSet, onSetError, waitForSet, onAfterSet } =
        persistOptions.remote || ({} as LegacyPersistOptionsRemote);
    const shouldSaveMetadata = local && offlineBehavior === 'retry';

    if (changesRemote.length > 0) {
        // Wait for remote to be ready before saving
        await when(() => syncState.isLoaded.get() || (allowSetIfError && syncState.error.get()));

        if (waitForSet) {
            const waitFor = isFunction(waitForSet)
                ? waitForSet({ changes: changesRemote, value: obs.peek() })
                : waitForSet;
            if (waitFor) {
                await when(waitFor);
            }
        }

        const value = obs.peek();

        onBeforeSet?.();

        localState.numSavesOutstanding = (localState.numSavesOutstanding || 0) + 1;

        let savedPromise = persistenceRemote!.set!({
            obs,
            syncState: syncState,
            options: persistOptions,
            changes: changesRemote,
            value,
        });
        if (isPromise(savedPromise)) {
            savedPromise = savedPromise.catch((err) => onSetError?.(err));
        }

        const saved = await savedPromise;

        localState.numSavesOutstanding--;

        // If this remote save changed anything then update persistence and metadata
        // Because save happens after a timeout and they're batched together, some calls to save will
        // return saved data and others won't, so those can be ignored.
        if (saved) {
            const pathStrs = Array.from(new Set(changesRemote.map((change) => change.pathStr)));
            const { changes, lastSync } = saved;
            if (pathStrs.length > 0) {
                if (local) {
                    const metadata: PersistMetadata = {};
                    const pending = persistenceLocal!.getMetadata(table, configLocal)?.pending;
                    let transformedChanges: object | undefined = undefined;

                    for (let i = 0; i < pathStrs.length; i++) {
                        const pathStr = pathStrs[i];
                        // Clear pending for this path
                        if (pending?.[pathStr]) {
                            // Remove pending from local state
                            delete pending[pathStr];
                            metadata.pending = pending;
                        }
                    }

                    if (lastSync) {
                        metadata.lastSync = lastSync;
                    }

                    // Remote can optionally have data that needs to be merged back into the observable,
                    // for example Firebase may update dateModified with the server timestamp
                    if (changes && !isEmpty(changes)) {
                        transformedChanges = transformLoadData(changes, persistOptions.remote!, false);
                    }

                    if (localState.numSavesOutstanding > 0) {
                        if (transformedChanges) {
                            if (!localState.pendingSaveResults) {
                                localState.pendingSaveResults = [];
                            }
                            localState.pendingSaveResults.push(transformedChanges);
                        }
                    } else {
                        let allChanges = [...(localState.pendingSaveResults || []), transformedChanges];
                        if (allChanges.length > 0) {
                            if (allChanges.some((change) => isPromise(change))) {
                                allChanges = await Promise.all(allChanges);
                            }
                            onChangeRemote(() => mergeIntoObservable(obs, ...allChanges));
                        }

                        if (shouldSaveMetadata && !isEmpty(metadata)) {
                            updateMetadata(obs, localState, syncState, persistOptions, metadata);
                        }

                        localState.pendingSaveResults = [];
                    }
                }
                onAfterSet?.();
            }
        }
    }
}

function onObsChange<T>(
    obs: Observable<T>,
    syncState: ObservableObject<ObservablePersistState>,
    localState: LocalState,
    persistOptions: LegacyPersistOptions<T>,
    { changes, loading, remote }: ListenerParams,
) {
    if (!loading) {
        const inRemoteChange = remote;
        const isApplyingPending = localState.isApplyingPending;
        // Queue changes in a microtask so that multiple changes within a frame get run together
        _queuedChanges.push({
            obs: obs as Observable<any>,
            syncState,
            localState,
            persistOptions,
            changes,
            inRemoteChange,
            isApplyingPending: isApplyingPending!,
        });
        if (_queuedChanges.length === 1) {
            queueMicrotask(processQueuedChanges);
        }
    }
}

async function loadLocal<T>(
    obs: ObservableParam<T>,
    persistOptions: LegacyPersistOptions<any>,
    syncState: ObservableObject<ObservablePersistState>,
    localState: LocalState,
) {
    const { local } = persistOptions;
    const localPersistence: ClassConstructor<ObservablePersistPlugin> =
        persistOptions.pluginLocal! || observablePersistConfiguration.pluginLocal;

    if (local) {
        const { table, config } = parseLocalConfig(local);

        if (!localPersistence) {
            throw new Error('Local persistence is not configured');
        }
        // Ensure there's only one instance of the persistence plugin
        if (!mapPersistences.has(localPersistence)) {
            const persistenceLocal = new localPersistence();
            const mapValue = { persist: persistenceLocal, initialized: observable(false) };
            mapPersistences.set(localPersistence, mapValue);
            if (persistenceLocal.initialize) {
                const initializePromise = persistenceLocal.initialize?.(
                    observablePersistConfiguration.localOptions || {},
                );
                if (isPromise(initializePromise)) {
                    await initializePromise;
                }
            }
            mapValue.initialized.set(true);
        }

        const { persist: persistenceLocal, initialized } = mapPersistences.get(localPersistence) as {
            persist: ObservablePersistPlugin;
            initialized: Observable<boolean>;
        };

        localState.persistenceLocal = persistenceLocal;

        if (!initialized.peek()) {
            await when(initialized);
        }

        // If persistence has an asynchronous load, wait for it
        if (persistenceLocal.loadTable) {
            const promise = persistenceLocal.loadTable(table, config);
            if (promise) {
                await promise;
            }
        }

        const node = getNode(obs);
        // Get current value for init
        const prevValue = getNodeValue(node) as object;

        // Get the value from state
        let value = persistenceLocal.getTable(table, prevValue, config);
        const metadata = persistenceLocal.getMetadata(table, config);

        if (metadata) {
            // @ts-expect-error Migration from old version
            if (!metadata.lastSync && metadata.modified) {
                // @ts-expect-error Migration from old
                metadata.lastSync = metadata.modified;
            }
            metadatas.set(obs, metadata);
            localState.pendingChanges = metadata.pending;
            // TODOV3 Remove dateModified
            syncState.assign({
                dateModified: metadata.lastSync,
                lastSync: metadata.lastSync,
            });
        }

        // Merge the data from local persistence into the default state
        if (value !== undefined) {
            const { transform, fieldTransforms } = config;

            value = transformLoadData(value, { transform, fieldTransforms }, true);

            if (isPromise(value)) {
                value = await value;
            }

            // isLoadingLocal prevents saving remotely when two different persistences
            // are set on the same observable
            internal.globalState.isLoadingLocal = true;

            // We want to merge the local data on top of any initial state the object is created with
            const prevValue = obs.peek();
            if (value === null && (!prevValue || (prevValue as any)[symbolLinked])) {
                obs.set(value);
            } else {
                mergeIntoObservable(obs, value);
            }

            internal.globalState.isLoadingLocal = false;
        }

        getNodeValue(getNode(node.state!)).clearLocal = () =>
            Promise.all([
                persistenceLocal.deleteTable(table, config),
                persistenceLocal.deleteMetadata(table, config),
            ]) as unknown as Promise<void>;
    }
    syncState.isLoadedLocal.set(true);
}

export function persistObservable<T>(
    observable: ObservableParam<T>,
    persistOptions: LegacyPersistOptions<T>,
): Observable<T>;
export function persistObservable<T>(
    initial: T | (() => T) | (() => Promise<T>),
    persistOptions: LegacyPersistOptions<T>,
): Observable<T>;
export function persistObservable<T>(
    initialOrObservable: ObservableParam<T> | T | (() => T) | (() => Promise<T>),
    persistOptions: LegacyPersistOptions<T>,
): Observable<T> {
    const obs$ = (
        isObservable(initialOrObservable)
            ? initialOrObservable
            : observable(isFunction(initialOrObservable) ? initialOrObservable() : initialOrObservable)
    ) as Observable<any>;
    const node = getNode(obs$);

    // Merge remote persist options with global options
    if (persistOptions.remote) {
        persistOptions.remote = Object.assign(
            {},
            observablePersistConfiguration.remoteOptions,
            removeNullUndefined(persistOptions.remote),
        );
    }
    let { remote } = persistOptions as { remote: LegacyPersistOptionsRemote<T> };
    const { local } = persistOptions;
    const remotePersistence = persistOptions.pluginRemote! || observablePersistConfiguration?.pluginRemote;
    const localState: LocalState = {};
    let sync: () => Promise<void>;

    const syncState = (node.state = observable<ObservablePersistState>({
        isLoadedLocal: false,
        isLoaded: false,
        isEnabledLocal: true,
        isEnabledRemote: true,
        clearLocal: undefined as unknown as () => Promise<void>,
        sync: () => Promise.resolve(),
        getPendingChanges: () => localState.pendingChanges,
    }) as any);

    loadLocal(obs$, persistOptions, syncState, localState);

    if (remote || remotePersistence) {
        if (!remotePersistence) {
            throw new Error('Remote persistence is not configured');
        }
        if (!remote) {
            remote = {};
        }
        if (isObject(remotePersistence)) {
            localState.persistenceRemote = observablePersistRemoteFunctionsAdapter(
                remotePersistence as ObservablePersistRemoteFunctions<T>,
            );
        } else {
            // Ensure there's only one instance of the persistence plugin
            if (!mapPersistences.has(remotePersistence)) {
                mapPersistences.set(remotePersistence, {
                    persist: new (remotePersistence as ClassConstructor<ObservablePersistRemoteClass, any[]>)(),
                });
            }
            localState.persistenceRemote = mapPersistences.get(remotePersistence)!
                .persist as ObservablePersistRemoteClass;
        }

        let isSynced = false;
        sync = async () => {
            const lastSync = metadatas.get(obs$)?.lastSync;
            const pending = localState.pendingChanges;
            const get = localState.persistenceRemote!.get?.bind(localState.persistenceRemote);

            if (get) {
                const runGet = () => {
                    get({
                        state: syncState,
                        obs: obs$,
                        options: persistOptions as LegacyPersistOptions<any>,
                        lastSync,
                        dateModified: lastSync,
                        onError: (error: Error) => {
                            remote.onGetError?.(error);
                        },
                        onGet: () => {
                            node.state!.assign({
                                isLoaded: true,
                                error: undefined,
                            });
                        },
                        onChange: async ({ value, path = [], pathTypes = [], mode = 'set', lastSync }) => {
                            // Note: value is the constructed value, path is used for setInObservableAtPath
                            // to start the set into the observable from the path
                            if (value !== undefined) {
                                value = transformLoadData(value, remote, true);
                                if (isPromise(value)) {
                                    value = await (value as Promise<T>);
                                }

                                const invertedMap = remote.fieldTransforms && invertFieldMap(remote.fieldTransforms);

                                if (path.length && invertedMap) {
                                    path = transformPath(path as string[], pathTypes, invertedMap);
                                }

                                if ((mode as any) === 'lastSync' || (mode as any) === 'dateModified') {
                                    if (lastSync && !isEmpty(value as unknown as object)) {
                                        onChangeRemote(() => {
                                            setInObservableAtPath(obs$, path as string[], pathTypes, value, 'assign');
                                        });
                                    }
                                } else {
                                    const pending = localState.pendingChanges;
                                    if (pending) {
                                        Object.keys(pending).forEach((key) => {
                                            const p = key.split('/').filter((p) => p !== '');
                                            const { v, t } = pending[key];

                                            if (t.length === 0 || !value) {
                                                value = v;
                                            } else if ((value as any)[p[0]] !== undefined) {
                                                (value as any) = setAtPath(
                                                    value as any,
                                                    p,
                                                    t,
                                                    v,
                                                    obs$.peek(),
                                                    (path: string[], value: any) => {
                                                        delete pending[key];
                                                        pending[path.join('/')] = {
                                                            p: null,
                                                            v: value,
                                                            t: t.slice(0, path.length),
                                                        };
                                                    },
                                                );
                                            }
                                        });
                                    }

                                    onChangeRemote(() => {
                                        setInObservableAtPath(
                                            obs$,
                                            path as string[],
                                            pathTypes,
                                            value,
                                            mode as 'assign' | 'set',
                                        );
                                    });
                                }
                            }
                            if (lastSync && local) {
                                updateMetadata(obs$, localState, syncState, persistOptions as LegacyPersistOptions<T>, {
                                    lastSync,
                                });
                            }
                        },
                    });
                };
                runGet();
            } else {
                node.state!.assign({
                    isLoaded: true,
                    error: undefined,
                });
            }
            if (!isSynced) {
                isSynced = true;
                // Wait for remote to be ready before saving pending
                await when(() => syncState.isLoaded.get() || (remote.allowSetIfError && syncState.error.get()));

                if (pending && !isEmpty(pending)) {
                    localState.isApplyingPending = true;
                    const keys = Object.keys(pending);

                    // Bundle up all the changes from pending
                    const changes: Change[] = [];
                    for (let i = 0; i < keys.length; i++) {
                        const key = keys[i];
                        const path = key.split('/').filter((p) => p !== '');
                        const { p, v, t } = pending[key];
                        changes.push({ path, valueAtPath: v, prevAtPath: p, pathTypes: t });
                    }

                    // Send the changes into onObsChange so that they get persisted remotely
                    // TODO: Not sure why this needs to as unknown as Observable
                    onObsChange(obs$ as unknown as Observable, syncState, localState, persistOptions, {
                        value: obs$.peek(),
                        loading: false,
                        remote: false,
                        // TODO getPrevious if any remote persistence layers need it
                        getPrevious: () => undefined,
                        changes,
                    });
                    localState.isApplyingPending = false;
                }
            }
        };

        syncState.assign({ sync });
    }

    // Wait for this node and all parent nodes up the hierarchy to be loaded
    const onAllLoadedLocal = () => {
        let parentNode: NodeValue | undefined = node;
        while (parentNode) {
            if (
                (parentNode.state as unknown as ObservableObject<ObservablePersistState>)?.isLoadedLocal?.get() ===
                false
            ) {
                return false;
            }
            parentNode = parentNode.parent;
        }
        return true;
    };
    // When all is loaded locally we can start syncing and listening for changes
    when(onAllLoadedLocal, function (this: any) {
        // If remote is not manual, then sync() is called automatically
        if (remote && !remote.manual) {
            sync();
        }

        obs$.onChange(
            onObsChange.bind(this, obs$ as any, syncState, localState, persistOptions as LegacyPersistOptions<any>),
        );
    });

    return obs$ as any;
}
