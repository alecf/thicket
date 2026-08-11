import { Bag } from "../bag.js";

export function project0(source: Bag) {
  return {
    labOrderId: source.labOrderId,
    memberId: source.memberId,
    practiceId: source.practiceId,
  };
}

export function project1(source: Bag) {
  return {
    average: source.average,
    minimum: source.minimum,
    maximum: source.maximum,
  };
}

export function project2(source: Bag) {
  return {
    system: source.system,
    code: source.code,
    display: source.display,
  };
}

export function project3(source: Bag) {
  return {
    accessToken: source.accessToken,
    refreshToken: source.refreshToken,
    expiresAt: source.expiresAt,
  };
}

export function project4(source: Bag) {
  return {
    street: source.street,
    city: source.city,
    postcode: source.postcode,
  };
}

export function project5(source: Bag) {
  return {
    width: source.width,
    height: source.height,
    depth: source.depth,
  };
}

export function project6(source: Bag) {
  return {
    firstName: source.firstName,
    lastName: source.lastName,
    email: source.email,
  };
}

export function project7(source: Bag) {
  return {
    hostname: source.hostname,
    port: source.port,
    protocol: source.protocol,
  };
}

export function project8(source: Bag) {
  return {
    title: source.title,
    author: source.author,
    isbn: source.isbn,
  };
}

export function project9(source: Bag) {
  return {
    latitude: source.latitude,
    longitude: source.longitude,
    altitude: source.altitude,
  };
}
