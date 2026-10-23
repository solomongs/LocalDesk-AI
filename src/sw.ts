/// <reference lib="webworker" />
import {precacheAndRoute,cleanupOutdatedCaches,createHandlerBoundToURL} from 'workbox-precaching';import {registerRoute,NavigationRoute} from 'workbox-routing';
declare const self:ServiceWorkerGlobalScope & {__WB_MANIFEST:Array<unknown>};
precacheAndRoute(self.__WB_MANIFEST as any);cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'),{denylist:[new RegExp('^/api/'),new RegExp('^/download/')]}));
self.addEventListener('message',e=>{if(e.data?.type==='SKIP_WAITING')self.skipWaiting()});
// Only the public app shell is precached. Model cache is owned by WebLLM.
