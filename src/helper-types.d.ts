declare module "modern-react-qr-reader";
declare module 'qrcode.react';

declare module 'dsp.js';

declare module "comlink-loader!*" {
    class WebpackWorker<T> extends Worker {
        constructor();
    }
    export default WebpackWorker;
}

declare module "comlink-loader?singleton=true!*" {
    class WebpackWorker<T> extends Worker {
        constructor();
    }
    export default WebpackWorker;
}
