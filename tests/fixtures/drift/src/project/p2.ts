import { Bag } from "../bag.js";

export function project20(source: Bag) {
  return {
    north: source.north,
    south: source.south,
    east: source.east,
  };
}

export function project21(source: Bag) {
  return {
    west: source.west,
    up: source.up,
    down: source.down,
  };
}

export function project22(source: Bag) {
  return {
    left: source.left,
    right: source.right,
    near: source.near,
  };
}

export function project23(source: Bag) {
  return {
    far: source.far,
    inner: source.inner,
    outer: source.outer,
  };
}

export function project24(source: Bag) {
  return {
    first: source.first,
    last: source.last,
    prev: source.prev,
  };
}

export function project25(source: Bag) {
  return {
    next: source.next,
    head: source.head,
    tail: source.tail,
  };
}

export function project26(source: Bag) {
  return {
    top: source.top,
    bottom: source.bottom,
    front: source.front,
  };
}

export function project27(source: Bag) {
  return {
    back: source.back,
    open: source.open,
    close: source.close,
  };
}

export function project28(source: Bag) {
  return {
    read: source.read,
    write: source.write,
    push: source.push,
  };
}

export function project29(source: Bag) {
  return {
    pull: source.pull,
    send: source.send,
    recv: source.recv,
  };
}
