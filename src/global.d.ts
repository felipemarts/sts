import { StsApi } from './shared/api';

declare global {
  interface Window {
    sts: StsApi;
  }
}

export {};
