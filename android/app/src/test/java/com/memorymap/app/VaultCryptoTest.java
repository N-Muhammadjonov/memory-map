package com.memorymap.app;
import org.junit.Test;
import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;

public class VaultCryptoTest {
    private static byte[] bytes(String s) { return s.getBytes(StandardCharsets.UTF_8); }
    private static byte[] hex(String value) {
        byte[] b = new byte[value.length()/2];
        for (int i=0;i<b.length;i++) b[i]=(byte) Integer.parseInt(value.substring(2*i,2*i+2),16);
        return b;
    }
    @Test public void compatibleEncryptionAndArgon2() throws Exception {
        byte[] key=hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"), nonce=hex("000102030405060708090a0b");
        byte[] encrypted=VaultCrypto.encrypt(key,nonce,bytes("Memory map interoperability"),bytes("Xotira/1"));
        assertArrayEquals(hex("0a67bb74b79ce276ec31b7e2df9d1d1feca6e2469119361051139c213d844cfa7648ce2051ebc63b2cbc53"), encrypted);
        assertArrayEquals(bytes("Memory map interoperability"), VaultCrypto.decrypt(key,nonce,encrypted,bytes("Xotira/1")));
        assertNull(VaultCrypto.decrypt(key,nonce,encrypted,bytes("different")));
        assertArrayEquals(hex("89fdb561604454c46840909daa697d3433920d0dc45e9031831eaa3d3dbb45a8"), VaultCrypto.derive(bytes("fixture-password"),bytes("0123456789abcdef"),32,3,4,65536));
    }
}
