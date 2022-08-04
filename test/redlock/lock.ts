import { getCached } from "../utilsWithRedlock";

(async () => {
  const data = await getCached(
    async () => {
      console.log("-- Executing expensive function --\n");

      await new Promise((resolve) => setTimeout(resolve, 5000));
      return "Hello World";
    },
    {
      ttl: "10 minutes",
      keys: "redlock-test",
      maxExpectedTime: "7 seconds",
      useRedlock: true,
    }
  );

  console.log(data);

  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
