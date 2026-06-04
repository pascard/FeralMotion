// Minimal ambient typing for the globally-loaded OpenCV.js build.
// We only type the handful of symbols this app uses.
declare global {
  interface Window {
    cv?: any;
    __opencvReady?: boolean;
  }
}
export {};
