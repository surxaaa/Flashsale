export const QUEUE = "orders";
export const PRODUCT_ID = 1;
export const POW_DIFFICULTY = 3; // leading hex zeros

export const KEYS = {
  stock: "sale:stock",
  buyers: "sale:buyers",
  open: "sale:open",
  order: (id: string) => `order:${id}`,
};

// returns 1 = reserved, 0 = sold out, -1 = user already has one
export const RESERVE_LUA = `
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return -1 end
local s = tonumber(redis.call('GET', KEYS[1]) or '0')
if s <= 0 then return 0 end
redis.call('DECR', KEYS[1])
redis.call('SADD', KEYS[2], ARGV[1])
return 1
`;

// only gives the unit back if the user is still in the buyers set,
// so calling it twice for the same order is harmless
export const RELEASE_LUA = `
if redis.call('SREM', KEYS[2], ARGV[1]) == 1 then
  redis.call('INCR', KEYS[1])
  return 1
end
return 0
`;
