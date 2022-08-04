export function getRemainingSeconds(date: Date) {
  return Math.max(Math.ceil((date.getTime() - Date.now()) / 1000), 0);
}

export class PLazy<ValueType> extends Promise<ValueType> {
  private _promise?: Promise<ValueType>;

  constructor(
    private _executor: (resolve: (value: ValueType) => void, reject: (err: unknown) => void) => void
  ) {
    super((resolve: (v?: any) => void) => resolve());
  }

  then: Promise<ValueType>["then"] = (onFulfilled, onRejected) =>
    (this._promise ||= new Promise(this._executor)).then(onFulfilled, onRejected);

  catch: Promise<ValueType>["catch"] = (onRejected) =>
    (this._promise ||= new Promise(this._executor)).catch(onRejected);

  finally: Promise<ValueType>["finally"] = (onFinally) =>
    (this._promise ||= new Promise(this._executor)).finally(onFinally);
}

export function LazyPromise<Value>(fn: () => Value | Promise<Value>): Promise<Value> {
  return new PLazy((resolve, reject) => {
    try {
      Promise.resolve(fn()).then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

export interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;

  value: {
    current?: PromiseSettledResult<T>;
  };
}

export function createDeferredPromise<T = void>(): DeferredPromise<T> {
  const resolve = (value: T) => {
    valueRef.current ||= { status: "fulfilled", value };

    middlePromiseResolve({
      value,
      resolved: true,
    });
  };

  const reject = (err: unknown) => {
    valueRef.current ||= { status: "rejected", reason: err };

    middlePromiseResolve({
      value: err,
      resolved: false,
    });
  };

  const valueRef: { current?: PromiseSettledResult<T> } = {};

  let middlePromiseResolve!: (value: { value: unknown; resolved: boolean }) => void;
  const MiddlePromise = new Promise<{
    value: unknown;
    resolved: boolean;
  }>((resolve) => {
    middlePromiseResolve = resolve;
  });

  const promise = LazyPromise<T>(async () => {
    const { resolved, value } = await MiddlePromise;

    if (resolved) return value as T;

    throw value;
  });

  return {
    promise,
    resolve,
    reject,
    value: valueRef,
  };
}
