import { getHostState, showCachedData, watchHosts } from "@/entities/host";
import {
  getProjectState,
  isProjectOnHost,
  showCachedProjects,
  watchProjects,
} from "@/entities/project";
import { getProviders, receiveProviders, watchProviders } from "@/entities/provider";
import { getSettings, showCachedSettings, watchSettings } from "@/entities/settings";
import {
  getThreadState,
  isThreadOnHost,
  loadCachedTranscript,
  showCachedThreads,
  watchThreads,
} from "@/entities/thread";
import { loadShell, saveShell } from "@/shared/cache";

/**
 * Resolves once the last run's state is on screen (or there is none), so the first
 * paint shows your threads, and the latest one's messages, rather than an empty app.
 */
export const ready: Promise<void> = loadShell().then(async (cached) => {
  // The daemon beat the cache: its data is newer.
  if (!cached || getHostState().source !== "none") return;

  const { dataId, settings, projects, providers, order, threads } = cached;
  showCachedThreads(order, threads);
  showCachedProjects(projects);
  showCachedSettings(settings);
  receiveProviders(null, providers);
  showCachedData(dataId);

  if (order[0]) await loadCachedTranscript(order[0]);
});

function saveLiveShell() {
  const { source, dataId } = getHostState();

  if (source !== "daemon" || dataId === null) return;

  // ponytail: only this Mac's shell is cached; remote hosts' threads appear once they connect
  const { order, threads } = getThreadState();

  const localThreads = Object.fromEntries(
    Object.entries(threads).filter(([, info]) => isThreadOnHost(null, info)),
  );

  saveShell({
    dataId,
    settings: getSettings(),
    providers: getProviders(),
    projects: getProjectState().projects.filter((project) => isProjectOnHost(null, project.id)),
    order: order.filter((id) => localThreads[id]),
    threads: localThreads,
  });
}

watchThreads((prev, next) => {
  if (prev.threads !== next.threads || prev.order !== next.order) saveLiveShell();
});

watchProjects((prev, next) => {
  if (prev.projects !== next.projects) saveLiveShell();
});

watchSettings((prev, next) => {
  if (prev.settings !== next.settings) saveLiveShell();
});

watchProviders((prev, next) => {
  if (prev.providers !== next.providers) saveLiveShell();
});

// The first shell sets the host's source last, after everything it saves.
watchHosts((prev, next) => {
  if (prev.source !== next.source || prev.dataId !== next.dataId) saveLiveShell();
});
