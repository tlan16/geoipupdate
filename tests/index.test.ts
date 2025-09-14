import {expect, test} from "bun:test";
import {ip_to_city} from '../index.ts'

test("ip_to_city", async () => {
  const response = await fetch('https://checkip.amazonaws.com/')
  expect(response.ok).toBe(true);
  const ip = (await response.text()).trim()
  expect(ip.length > 0).toBe(true);

  const city = await ip_to_city(ip);
  expect(city).toBeTruthy();
  expect(typeof city).toBe('object')
  console.log(city)
}, {timeout: 60_000});
