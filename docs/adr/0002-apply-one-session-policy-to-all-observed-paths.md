# Apply one session policy to all observed paths

One trusted project configuration will define the session policy for every observed mutation, including files outside the working directory. We rejected nearest-file configuration discovery because it would make one session obey multiple implicit policies and require trusting configuration beside external files; external paths therefore remain governed by the initiating session.
