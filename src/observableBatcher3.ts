import { clearTimeoutOnce, timeoutOnce } from '@legendapp/tools';
import { ListenerFn3, ObservableListenerInfo2 } from './observableInterfaces';

let numInBatch = 0;
let _batch: { cb: ListenerFn3<any>; value: any; info: ObservableListenerInfo2 }[] = [];

function onActionTimeout() {
    if (_batch.length > 0) {
        if (process.env.NODE_ENV === 'development') {
            console.error(
                'Forcibly completing observableBatcher because end() was never called. This may be due to an uncaught error between begin() and end().'
            );
        }
        observableBatcher.end(/*force*/ true);
    }
}

export function observableBatcherNotify(cb: ListenerFn3<any>, value: any, info: ObservableListenerInfo2) {
    if (numInBatch > 0) {
        for (let i = 0; i < _batch.length; i++) {
            const n = _batch[i];
            // If this callback already exists, make sure it has the latest value but do not add it
            if (n.cb === cb) {
                n.value = value;
                n.info = info;
                return;
            }
        }
        _batch.push({ cb, value, info });
    } else {
        cb(value, info);
    }
}

export namespace observableBatcher {
    export function batch(fn: () => void) {
        begin();
        fn();
        end();
    }
    export function begin() {
        numInBatch++;
        // Set a timeout to call end() in case end() is never called or there's an uncaught error
        timeoutOnce('batch_beginAction', onActionTimeout, 0);
    }
    export function end(force?: boolean) {
        numInBatch--;
        if (numInBatch <= 0 || force) {
            clearTimeoutOnce('batch_beginAction');
            numInBatch = 0;
            // Save batch locally and reset _batch first because a new batch could begin while looping over callbacks.
            // This can happen with observableComputed for example.
            const batch = _batch;
            _batch = [];
            batch.forEach(({ cb, value, info }) => cb(value, info));
        }
    }
}