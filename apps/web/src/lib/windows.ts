/** Opens another app window: a new chat in `path`, or the project picker when there's none. */
export const openWindow = (path: string | null) => {
  window.open(path ? `/?path=${encodeURIComponent(path)}` : "/?home=1", "_blank");
};
