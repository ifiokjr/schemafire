import { Cast, invariant, logError, removeUndefined } from '@schemafire/core';
import admin from 'firebase-admin';
import {
  AnyProps,
  interface as ioInterface,
  TypeOf as IOTypeOf,
  TypeOfProps,
  Validation as IOValidation,
} from 'io-ts';
import { isEmpty, pick, uniq } from 'lodash/fp';
import {
  BaseDefinition,
  baseProps,
  createDefaultBase,
  isCollectionReference,
  isDocumentReference,
  isFirestoreAdminTimestamp,
  isGeoPoint,
  omitBaseFields,
} from './base';
import {
  buildMirrorData,
  buildUpdatedData,
  createJSONRepresentation,
  createMethods,
  createTransaction,
  createTransactionState,
  createTypeHasData,
  deleteTransaction,
  getIdFieldFromSchema,
  getTransaction,
  queryTransaction,
  runCallbacks,
  snapshotExists,
  updateTransaction,
} from './model.utils';
import { createDataProxy } from './proxy';
import {
  BaseInjectedDeps,
  FirestoreRecord,
  IModel,
  InstanceMethodConfig,
  ISchema,
  JSONifyProps,
  LastRunStatus,
  MappedInstanceMethods,
  ModelAction,
  ModelActions,
  ModelActionType,
  ModelCallback,
  ModelParams,
  QueryTuples,
  RunConfig,
  SchemaCacheRules,
  SchemaConfig,
  TransactionState,
  TypeOfPropsWithBase,
} from './types';
import {
  actionsContainCallback,
  actionsContainCreate,
  actionsContainDelete,
  actionsContainFind,
  actionsContainFindOrCreate,
  actionsContainUpdate,
  buildQuery,
  findQueryAction,
  getRecord,
  isBaseProp,
  serverUpdateTimestamp,
} from './utils';
import { SchemaFireValidationError } from './validation';

export class Model<
  GProps extends AnyProps,
  GInstanceMethods extends InstanceMethodConfig<GProps, GDependencies>,
  GDependencies extends BaseInjectedDeps
> implements IModel<GProps, GInstanceMethods, GDependencies> {
  /**
   * All actions which are queued for this model that haven't yet been synced with the database.
   *
   * @private
   */
  private actions: Array<
    ModelAction<TypeOfProps<GProps>, IModel<GProps, GInstanceMethods, GDependencies>>
  > = [];

  private rawData: IOTypeOf<any>;
  private currentRunConfig: SchemaConfig;
  private errors: Error[] = [];
  private lastRunStatus?: LastRunStatus;
  private existsViaCreation: boolean = false;
  private actionsRun: ModelActions = {};
  private baseData: BaseDefinition;
  // After any successful run this is set to true. At this point we no longer provide mock values for any of the base data
  private hasRunSuccessfully = false;
  private dataProxy: TypeOfPropsWithBase<GProps>;

  get data(): TypeOfPropsWithBase<GProps> {
    return this.dataProxy;
  }
  public doc: FirebaseFirestore.DocumentReference;
  public id: string;
  public snap?: FirebaseFirestore.DocumentSnapshot;
  public schema: ISchema<GProps, GInstanceMethods, GDependencies>;
  public methods: MappedInstanceMethods<GProps, GInstanceMethods, GDependencies>;

  get exists(): boolean {
    return snapshotExists(this.snap, this.existsViaCreation);
  }

  /**
   * Used to create models which are wrappers around firestore documents.
   *
   * Typically this isn't called directly in end user code but via a creation method of the schema.
   */
  constructor({
    schema,
    data,
    doc,
    id,
    snap,
    type,
    callback,
    clauses,
    methods,
  }: ModelParams<GProps, GInstanceMethods, GDependencies>) {
    this.schema = schema;
    this.rawData = { ...schema.defaultData, ...data };
    this.baseData = createDefaultBase({ schemaVersion: this.schema.version });

    this.dataProxy = createDataProxy({
      actions: this.actions,
      baseData: this.baseData,
      useBaseData: () => !this.hasRunSuccessfully,
      target: this.rawData,
    });

    this.snap = snap;
    this.doc = this.getDoc(doc, id);
    this.id = id || this.doc.id;

    this.methods = createMethods(methods, this);
    this.setupInitialActions(type, data, callback, clauses);
    this.currentRunConfig = this.schema.config;
  }

  /**
   * Set up the initial actions based on the data that was passed in at model creation.
   *
   * @param type a type of model action
   * @param data the data provided at instantiation
   * @param callback a callback run when the run is called (provides access to a getter)
   * @param clauses clauses for setting a query
   */
  private setupInitialActions(
    type?: ModelActionType,
    data?: any,
    callback?: ModelCallback<IModel<GProps, GInstanceMethods, GDependencies>>,
    clauses?: QueryTuples<GProps>,
  ) {
    if (callback) {
      this.attach(callback);
    }

    if (!type) {
      return;
    }

    // Will throw if this is a FindOrCreate | Create action but no data was passed through
    invariant(createTypeHasData(type, data), `The creation type '${type}' must define data`);

    if (type === ModelActionType.Create) {
      this.create(data);
    }

    if (type === ModelActionType.Delete) {
      this.delete();
    }

    if (type === ModelActionType.FindOrCreate) {
      this.create(data, false);
    }

    if (type === ModelActionType.Find) {
      this.actions.push({ type: ModelActionType.Find });
    }

    if (type === ModelActionType.Query) {
      invariant(Boolean(clauses && clauses.length), `Type '${type}' must be defined with clauses`);
      this.actions.push({ type: ModelActionType.Query, data: clauses! });
    }
  }

  /**
   * Retrieves or creates the document reference object for this model.
   *
   * @param doc a firebase document reference
   * @param id the fallback id
   */
  private getDoc(doc?: FirebaseFirestore.DocumentReference, id?: string) {
    if (doc) {
      return doc;
    }
    if (this.snap) {
      return this.snap.ref;
    }
    if (id) {
      return this.schema.ref.doc(id);
    }
    return this.schema.ref.doc();
  }

  /**
   * Determines whether the Schema has set up mirroring correctly
   */
  private canMirror(): this is this & {
    schema: ISchema<GProps, GInstanceMethods, GDependencies, any> & {
      mirror: SchemaCacheRules<keyof GProps>;
    };
  } {
    return Boolean(this.schema.mirror && this.id && this.currentRunConfig.mirror === true);
  }

  /**
   * Performs the mirroring within a transaction.
   */
  private mirrorTransaction(
    transaction: FirebaseFirestore.Transaction,
    allUpdates: TypeOfProps<GProps> | 'delete',
  ) {
    if (!this.canMirror()) {
      return;
    }

    const db = this.schema.db;

    const { name: key, idField } = this.schema.mirror;
    const mirrorId: string = idField ? this.rawData[idField] : this.id;

    if (!mirrorId) {
      logError(
        `Mirroring failed due to no provided id ${JSON.stringify({
          id: this.id,
          rawData: this.rawData,
        })}`,
      );
      return;
    }

    const doc = db.collection(this.schema.mirror.collection).doc(mirrorId);

    if (allUpdates === 'delete') {
      transaction.set(doc, serverUpdateTimestamp({ [key]: admin.firestore.FieldValue.delete() }), {
        merge: true,
      });
      return;
    }

    const data = buildMirrorData(allUpdates, this.schema.mirror.fields);

    /* Firebase overwrites the key if an empty object is set, so we want to guard against this. */
    if (isEmpty(data)) {
      logError('No data passed into the model');
      return;
    }

    if (key.includes('.')) {
      transaction.update(doc, serverUpdateTimestamp({ [key]: removeUndefined(data) }));
    }

    transaction.set(doc, serverUpdateTimestamp({ [key]: removeUndefined(data) }), {
      merge: true,
    });
  }

  private removeAllDataExceptMirrorIdField() {
    const idField: string | undefined = getIdFieldFromSchema(this.schema);
    if (idField) {
      return { [idField]: this.rawData[idField] };
    }
    return {};
  }

  /**
   * Update the new data and create a new data proxy.
   *
   * @param newData the data to be updated
   */
  private resetRawData(newData: any) {
    this.rawData = newData;
    this.dataProxy = createDataProxy({
      actions: this.actions,
      baseData: this.baseData,
      useBaseData: () => !this.hasRunSuccessfully,
      target: this.rawData,
    });
  }

  /**
   * Runs a transaction that handles all use cases for the update state of a model.
   */
  private async buildTransaction(maxAttempts?: number, alwaysGet?: boolean) {
    if (isEmpty(this.actions) && !alwaysGet) {
      logError('No data to process for this model');
      return;
    }
    const doc = this.doc;

    return this.schema.db.runTransaction(
      async transaction => {
        /* Create the state that will be passed out of this transaction if successful */
        let state = createTransactionState<GProps, this>({ rawData: this.rawData, actions: this.actions });

        if (actionsContainDelete(this.actions)) {
          const idField = getIdFieldFromSchema(this.schema);
          if (idField && !this.rawData[idField]) {
            state = await getTransaction({ transaction, doc, state });
            // ! this.resetRawData(this.removeAllDataExceptMirrorIdField());
          }

          this.mirrorTransaction(transaction, 'delete');
          return deleteTransaction({ transaction, state, doc });
          // ! Make sure the data is still reset after a delete
          // ! this.resetRawData({});
        }

        const queryModelAction = findQueryAction(this.actions);
        if (queryModelAction) {
          const query = buildQuery(this.schema.ref, queryModelAction.data);
          state = await queryTransaction({ transaction, query, state });
        }

        if (actionsContainCallback(this.actions)) {
          state = await getTransaction({ transaction, state, doc });
          runCallbacks({ state, ctx: this, baseData: this.baseData });
        }

        const actions = [...this.actions, ...state.actions];

        // Callbacks can add create actions so we need to check again.

        const data = buildUpdatedData({
          rawData: state.rawData,
          actions,
        });

        // This allows us to ignore deleted fields when creating new data.

        const dataWithoutDeletes = buildUpdatedData({
          withoutDeletes: true,
          rawData: state.rawData,
          actions,
        });

        if (actionsContainFind(this.actions)) {
          state = await getTransaction({ transaction, doc, state });
        }

        if (actionsContainFindOrCreate(this.actions)) {
          state = await getTransaction({ transaction, state, doc });

          if (!snapshotExists(state.syncData && state.syncData.snap, this.existsViaCreation)) {
            this.throwIfInvalid();

            state = createTransaction({ transaction, data: dataWithoutDeletes, state, doc });
            this.mirrorTransaction(transaction, dataWithoutDeletes);
            return state;
          }
        }

        if (actionsContainCreate(this.actions)) {
          this.throwIfInvalid();

          state = createTransaction({ transaction, data: dataWithoutDeletes, force: true, doc, state });
          this.mirrorTransaction(transaction, dataWithoutDeletes);
          return state;
        }

        const emptyData = isEmpty(data);

        if (alwaysGet) {
          state = await getTransaction({ transaction, state, doc, noData: !emptyData });
        }

        if (emptyData) {
          return state;
        }

        this.throwIfInvalid();

        state = updateTransaction({ transaction, data, doc, state });
        this.mirrorTransaction(transaction, data);
        return state;
      },
      { maxAttempts },
    );
  }

  /**
   * Will throw an error if data is invalid.
   */
  private throwIfInvalid() {
    if (!this.currentRunConfig.autoValidate) {
      return;
    }
    const error = this.validate();
    if (error) {
      throw error;
    }
  }

  private async getSnap() {
    const record = await getRecord<TypeOfProps<GProps>>(this.doc);
    this.syncData(record);
  }

  /**
   * Synchronize data after pulling down from FireStore.
   */
  private syncData(record: FirestoreRecord<TypeOfProps<GProps>>) {
    this.resetRawData(record.data ? record.data : this.rawData);
    this.doc = record.doc;
    this.snap = record.snap;
    this.id = this.doc.id;
  }

  private setCurrentConfig(config: RunConfig = {}) {
    this.currentRunConfig = { ...this.schema.config, ...config };
  }

  /**
   * When a model is created there is no snapshot but we want the user to have a way of knowing whether the model exists or not.
   * We pass a flag during the run to tell whether the model has been created or updated, or deleted.
   */
  private manageLastRunStatus() {
    if (!this.lastRunStatus) {
      return;
    }
    this.existsViaCreation = ['updated', 'created', 'force-created'].includes(this.lastRunStatus);
  }

  private async forceGetIfNeeded(config: RunConfig) {
    if (config.forceGet && (this.actionsRun.create || this.actionsRun.forceCreate)) {
      await this.getSnap();
    }
  }

  private updateModelWithTransactionState(state: TransactionState<GProps, this>) {
    this.actionsRun = state.actionsRun;
    this.errors = state.errors;
    this.lastRunStatus = state.lastRunStatus;
    if (state.syncData) {
      this.syncData(state.syncData);
    }

    if (state.actionsRun.delete) {
      this.resetRawData({});
    }
  }

  /**
   * Runs through all the pending actions and updates the cloud firestore database.
   */
  public run = async (config: RunConfig = {}): Promise<this> => {
    this.setCurrentConfig(config);
    try {
      const state = await this.buildTransaction(config.maxAttempts, config.forceGet);
      if (!state) {
        return this;
      }

      this.updateModelWithTransactionState(state);
      this.manageLastRunStatus();
      if (this.errors.length) {
        // Manage the harder to catch errors and rethrow
        throw this.errors[0];
      }

      await this.forceGetIfNeeded(config);

      // Only reset if successful
      this.hasRunSuccessfully = true;
      this.actions = [];
    } catch (e) {
      logError('Something went wrong with the latest push', e);
      // Rethrow the error
      throw e;
    } finally {
      // Reset the config for this run
      this.setCurrentConfig();
      this.errors = [];
      this.lastRunStatus = undefined;
      this.actionsRun = {};
    }

    return this;
  };

  public delete = (keys?: Array<keyof GProps>) => {
    if (keys) {
      keys.forEach(key => {
        if (isBaseProp(key)) {
          throw new Error(
            `An error occurred deleting the field '${key}': This is a protected field and should not be deleted`,
          );
        }
        delete this.data[key];
      });
    } else {
      this.actions.push({
        type: ModelActionType.Delete,
      });
      this.resetRawData(this.rawData);
    }
    return this;
  };

  /**
   * Update multiple fields at one time
   */
  public update = (data: TypeOfProps<GProps>) => {
    type Data = Partial<TypeOfProps<GProps>>;
    if (isEmpty(data)) {
      return this;
    }

    Object.entries(data).forEach(([key, val]) => {
      this.actions.push({
        data: Cast<Data>({ [key]: val }),
        type: ModelActionType.Update,
      });
      this.data[key] = val;
    });
    return this;
  };

  public create = (data: TypeOfProps<GProps>, force: boolean = true) => {
    this.actions.push({
      data,
      type: Cast<ModelActionType.Create>(force ? ModelActionType.Create : ModelActionType.FindOrCreate),
    });
    this.resetRawData({ ...this.rawData, ...data });
    return this;
  };

  /**
   * Attach a callback for when data is next received within a transaction
   * @param callback the callback to use when
   */
  public attach = (callback: ModelCallback<IModel<GProps, GInstanceMethods, GDependencies>>) => {
    this.actions.push({
      type: ModelActionType.Callback,
      callback,
    });
    return this;
  };

  /**
   * Validates the data currently held in raw data.
   *
   * Returns an error if one is found otherwise return undefined.
   */
  public validate = () => {
    const data = omitBaseFields(this.rawData);
    let report: IOValidation<any> = this.schema.codec.decode(data);
    const isCreateAction = actionsContainCreate(this.actions) || actionsContainFindOrCreate(this.actions);
    if (isCreateAction) {
      // Fall through
    } else if (actionsContainUpdate(this.actions)) {
      const updatedData = buildUpdatedData({ actions: this.actions, rawData: this.rawData }); // Get the data to be updated
      const updatedKeys = Object.keys(updatedData); // Pick the keys for generating our codec and data to test
      const codec = ioInterface(pick(updatedKeys, this.schema.codec.props));

      report = codec.decode(pick(updatedKeys, data));
    }
    return report.fold(SchemaFireValidationError.create, () => undefined);
  };

  public toJSON(): JSONifyProps<GProps> {
    const initialData: JSONifyProps<GProps> = Cast({ id: this.id });
    const keys = uniq([...this.schema.keys, ...baseProps]);
    return keys.reduce((prev, curr) => {
      const originalValue: TypeOfPropsWithBase<GProps>[typeof curr] = this.data[curr];
      let value: unknown;
      if (isFirestoreAdminTimestamp(originalValue)) {
        value = createJSONRepresentation('timestamp', originalValue.toDate().toJSON());
      } else if (isCollectionReference(originalValue)) {
        value = createJSONRepresentation('coll', originalValue.path);
      } else if (isDocumentReference(originalValue)) {
        value = createJSONRepresentation('doc', originalValue.path);
      } else if (isGeoPoint(originalValue)) {
        value = createJSONRepresentation('geo', {
          latitude: originalValue.latitude,
          longitude: originalValue.longitude,
        });
      } else {
        value = originalValue;
      }

      return { ...prev, [curr]: value };
    }, initialData);
  }
}
