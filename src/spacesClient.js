/**
 * Minimale S3-client (AWS Signature V4) voor DigitalOcean Spaces, alleen
 * GET en PUT van één object. Overgenomen uit de boekingsformulier-backend
 * (src/config/spacesClient.js), zodat ook deze app zonder AWS-pakket werkt.
 */
import { createHash, createHmac } from "node:crypto";

const sha256Hex = (d) => createHash("sha256").update(d ?? "", "utf8").digest("hex");
const hmac = (k, d) => createHmac("sha256", k).update(d, "utf8").digest();
const awsUriEncode = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function signedRequest({ method, key, body, contentType, accessKeyId, secretAccessKey, bucket, region, endpointHost, scheme, fetchImpl }) {
  const amzDate = new Date().toISOString().replace(/[:-]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const host = `${bucket}.${endpointHost}`;
  const canonicalUri = "/" + key.split("/").map(awsUriEncode).join("/");
  const payloadHash = sha256Hex(body);
  const h = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (contentType) h["content-type"] = contentType;
  const names = Object.keys(h).sort();
  const canonicalRequest = [method, canonicalUri, "", names.map((n) => `${n}:${h[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return fetchImpl(`${scheme}://${host}${canonicalUri}`, { method, headers: { ...h, Authorization: authorization }, body: method === "PUT" ? body : undefined });
}

export function createSpacesClient({ accessKeyId, secretAccessKey, bucket, region, endpoint, fetchImpl = fetch }) {
  const scheme = endpoint.startsWith("http://") ? "http" : "https";
  const endpointHost = endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const base = { accessKeyId, secretAccessKey, bucket, region, endpointHost, scheme, fetchImpl };
  return {
    async getObject(key) {
      const res = await signedRequest({ ...base, method: "GET", key, body: "" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Spaces GET "${key}" gaf status ${res.status}`);
      return res.text();
    },
    async putObject(key, contents, contentType = "application/json") {
      const res = await signedRequest({ ...base, method: "PUT", key, body: contents, contentType });
      if (!res.ok) throw new Error(`Spaces PUT "${key}" gaf status ${res.status}`);
    },
  };
}
