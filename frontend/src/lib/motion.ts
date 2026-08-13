export function scrollBehavior(reduceMotion: boolean): ScrollBehavior {
  return reduceMotion ? "auto" : "smooth";
}
