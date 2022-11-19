from setuptools import setup, find_packages

setup(
    name='snapfile',

    # Versions should comply with PEP440.
    version='0.2.0',

    description='A file transferring tool',

    # Author details
    author='Xurui Yan',
    author_email = "yanxurui1993@qq.com",
    url="https://github.com/yanxurui/Snapfile",

    classifiers=[
        # Specify the Python versions you support here.
        'Programming Language :: Python :: 3.8',
    ],

    # You can just specify the packages manually here if your project is
    # simple. Or you can use find_packages().
    packages=find_packages(exclude=['tests']),
    # Alternatively, if you want to distribute just a my_module.py, uncomment
    # this:
    #   py_modules=["my_module"],

    # include non-python files listed in MANIFEST.in
    include_package_data=True,

    # List run-time dependencies here. These will be installed by pip when
    # your project is installed.
    install_requires=[
        'aiohttp==3.6.2',
        'aiohttp-security==0.4.0',
        'aiohttp-session==2.9.0',
        'aioredis==2.0.1',
        'user_agents'
    ],

    # To provide executable scripts, use entry points in preference to the
    # "scripts" keyword. Entry points provide cross-platform support and allow
    # pip to create the appropriate form of executable for the target platform.
    entry_points={
        'console_scripts': [
            'snapfile=snapfile.__main__:main',
        ],
    },
)
