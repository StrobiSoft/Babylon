# Observer checkpoint recovery probe

The previously reviewed NOEMI Observer v0.1 checkpoint is `fd38783318e19edcefc155b1b972a45134597bf5`. Recovery work must reuse that checkpoint when it is reachable; it must not silently replace the reviewed design with an unrelated implementation. If the nested checkpoint is not reachable from the Babylon repository, the exact bundle and runbooks must first be exported from CT105 before activation work continues.
