// A thread runs on the host of its project, and a folder's commands go to the host of the project holding it.
export {
  findPendingPathHost,
  findProjectHostForPath,
  getProjectHost,
  isProjectOnHost,
  useProjectStore,
} from "../model/project-store.ts";
