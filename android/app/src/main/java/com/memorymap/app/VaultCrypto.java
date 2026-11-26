package com.memorymap.app;

import java.security.GeneralSecurityException;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.crypto.generators.Argon2BytesGenerator;
import org.bouncycastle.crypto.params.Argon2Parameters;

/** Uses platform AES-GCM and the maintained Bouncy Castle Argon2id implementation. */
public final class VaultCrypto {
    private VaultCrypto() {}

    private static Cipher cipher(int mode, byte[] key, byte[] nonce, byte[] aad)
            throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        cipher.updateAAD(aad);
        return cipher;
    }

    public static byte[] encrypt(byte[] key, byte[] nonce, byte[] data, byte[] aad)
            throws GeneralSecurityException {
        return cipher(Cipher.ENCRYPT_MODE, key, nonce, aad).doFinal(data);
    }

    public static byte[] decrypt(byte[] key, byte[] nonce, byte[] data, byte[] aad)
            throws GeneralSecurityException {
        try {
            return cipher(Cipher.DECRYPT_MODE, key, nonce, aad).doFinal(data);
        } catch (AEADBadTagException error) {
            return null;
        }
    }

    public static byte[] derive(byte[] password, byte[] salt, int length, int iterations,
                                int lanes, int memoryCost) {
        Argon2Parameters parameters = new Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withSalt(salt).withIterations(iterations).withParallelism(lanes)
            .withMemoryAsKB(memoryCost).build();
        Argon2BytesGenerator generator = new Argon2BytesGenerator();
        generator.init(parameters);
        byte[] output = new byte[length];
        generator.generateBytes(password, output);
        return output;
    }
}
