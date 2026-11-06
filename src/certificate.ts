import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generate } from 'selfsigned'

export interface TlsFiles {
  key: string
  cert: string
}

/**
 * OpenCPN's peer client does not verify the server certificate
 * (CURLOPT_SSL_VERIFYPEER 0), so a self-signed one made once and kept in the
 * plugin's data directory is enough.
 */
export async function loadOrCreateCertificate(dir: string, commonName: string): Promise<TlsFiles> {
  const keyFile = join(dir, 'key.pem')
  const certFile = join(dir, 'cert.pem')
  try {
    return { key: await readFile(keyFile, 'utf8'), cert: await readFile(certFile, 'utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const notAfterDate = new Date()
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 20)
  const pems = await generate([{ name: 'commonName', value: commonName }], {
    keySize: 2048,
    notAfterDate
  })
  await writeFile(keyFile, pems.private, { mode: 0o600 })
  await writeFile(certFile, pems.cert)
  return { key: pems.private, cert: pems.cert }
}
